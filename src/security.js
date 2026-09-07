'use strict';

let electronShell = null;
try {
    const electron = require('electron');
    if (electron && electron.shell) {
        electronShell = electron.shell;
    }
} catch (_) {}

const TRUSTED_TELEPHONY_CERTIFICATE_ERRORS = new Set([
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CERT_COMMON_NAME_INVALID'
]);

function shouldTrustTelephonyCertificate(url, error, telephonyOrigin) {
    if (!TRUSTED_TELEPHONY_CERTIFICATE_ERRORS.has(error)) return false;

    try {
        const parsed = new URL(url);
        const telephonyParsed = new URL(telephonyOrigin);
        return (
            (parsed.protocol === 'https:' || parsed.protocol === 'wss:') &&
            parsed.hostname === telephonyParsed.hostname &&
            parsed.port === telephonyParsed.port
        );
    } catch (_) {
        return false;
    }
}

/**
 * Configure strict permission and navigation security policies.
 *
 * @param {object} crmSession
 * @param {object} telephonySession
 * @param {object} config
 */
function applySecurityPolicy(crmSession, telephonySession, config) {
    // 1. Telephony Session Permissions
    telephonySession.setPermissionCheckHandler((_, permission, requestingOrigin) => {
        if (requestingOrigin !== config.telephonyOrigin) return false;
        return permission === 'media' || permission === 'speaker-selection' || permission === 'notifications';
    });

    telephonySession.setPermissionRequestHandler((_, permission, callback, details) => {
        const requestingUrl = details.requestingUrl || '';
        let requestingOrigin = '';
        try {
            requestingOrigin = new URL(requestingUrl).origin;
        } catch (_) {}

        if (requestingOrigin !== config.telephonyOrigin) {
            return callback(false);
        }

        if (permission === 'media') {
            const hasVideo = details.mediaTypes && details.mediaTypes.includes('video');
            return callback(!hasVideo); // Audio only
        }

        callback(permission === 'speaker-selection' || permission === 'notifications');
    });

    // 2. CRM Session Permissions
    crmSession.setPermissionCheckHandler((_, permission, requestingOrigin) => {
        if (requestingOrigin) {
            const isAllowed = requestingOrigin.startsWith(config.crmOrigin) || requestingOrigin.startsWith(config.telephonyOrigin);
            if (!isAllowed) return false;
        }
        return permission === 'media' || permission === 'speaker-selection' || permission === 'notifications';
    });

    crmSession.setPermissionRequestHandler((_, permission, callback, details) => {
        const requestingUrl = details.requestingUrl || '';
        let requestingOrigin = '';
        try {
            requestingOrigin = new URL(requestingUrl).origin;
        } catch (_) {}
        if (requestingOrigin && requestingOrigin !== config.crmOrigin && requestingOrigin !== config.telephonyOrigin) {
            return callback(false);
        }

        if (permission === 'media') {
            const hasVideo = details.mediaTypes && details.mediaTypes.includes('video');
            return callback(!hasVideo);
        }

        if (permission === 'speaker-selection' || permission === 'notifications') {
            return callback(true);
        }

        callback(false);
    });

    // 3. Prevent unapproved downloads in telephony worker
    telephonySession.on('will-download', (event) => {
        event.preventDefault();
    });
}

function handleCrmNavigation(event, targetUrl, crmOrigin, shellInstance = electronShell) {
    try {
        const parsed = new URL(targetUrl);
        // Allow navigation within CRM origin
        if (parsed.origin === crmOrigin) {
            return true;
        }

        // Open external links in default OS browser
        event.preventDefault();
        if (['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) && shellInstance) {
            shellInstance.openExternal(targetUrl).catch(() => {});
        }
        return false;
    } catch (_) {
        event.preventDefault();
        return false;
    }
}

module.exports = {
    applySecurityPolicy,
    handleCrmNavigation,
    shouldTrustTelephonyCertificate
};
