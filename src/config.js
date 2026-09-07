'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CRM_URL = 'http://192.168.100.216';
const DEFAULT_TELEPHONY_URL = 'https://100.110.36.17:8443/phone';

function validateUrl(rawUrl, paramName = 'URL') {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error(`${paramName} must be a non-empty string`);
    }

    const trimmed = rawUrl.trim();
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (_) {
        throw new Error(`Invalid ${paramName} syntax: ${trimmed}`);
    }

    if (parsed.username || parsed.password) {
        throw new Error(`${paramName} must not contain credentials`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${paramName} protocol must be http: or https:`);
    }

    const portPart = parsed.port ? `:${parsed.port}` : '';
    let pathname = parsed.pathname || '';
    if (pathname === '/') {
        pathname = '';
    } else if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
    }

    return `${parsed.protocol}//${parsed.hostname}${portPart}${pathname}`;
}

function getOrigin(urlStr) {
    const parsed = new URL(urlStr);
    return parsed.origin;
}

function getMachineConfigPath() {
    if (process.platform === 'win32') {
        const programData = process.env.ProgramData || 'C:\\ProgramData';
        return path.join(programData, 'Sokrat CRM V2', 'config.json');
    }
    return '/etc/sokrat-crm-v2/config.json';
}

function getUserConfigPath() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : 'C:\\');
        return path.join(appData, 'sokrat-crm-v2-desktop', 'config.json');
    }
    const home = process.env.HOME || '/root';
    return path.join(home, '.config', 'sokrat-crm-v2-desktop', 'config.json');
}

function saveUserConfig(newConfig = {}, options = {}) {
    const {
        userConfigPath = getUserConfigPath()
    } = options;

    const validatedCrmUrl = validateUrl(newConfig.crmUrl, 'CRM URL');
    const validatedTelephonyUrl = validateUrl(newConfig.telephonyUrl, 'Telephony URL');

    const configDir = path.dirname(userConfigPath);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    const payload = {
        crmUrl: validatedCrmUrl,
        telephonyUrl: validatedTelephonyUrl,
        savedAt: new Date().toISOString()
    };

    fs.writeFileSync(userConfigPath, JSON.stringify(payload, null, 2), 'utf8');

    return resolveConfig({ allowEnv: true, userConfigPath });
}

function resolveConfig(options = {}) {
    const {
        allowEnv = false,
        machineConfigPath = getMachineConfigPath(),
        userConfigPath = getUserConfigPath(),
        packagedConfigPath = path.join(__dirname, 'app-config.json')
    } = options;
    let crmUrl = null;
    let telephonyUrl = null;
    let configSource = 'default';

    // 1. Environment variables
    if (allowEnv) {
        if (process.env.SOKRAT_CRM_URL) {
            crmUrl = process.env.SOKRAT_CRM_URL;
            configSource = 'environment';
        }
        if (process.env.SOKRAT_TELEPHONY_URL) {
            telephonyUrl = process.env.SOKRAT_TELEPHONY_URL;
            configSource = 'environment';
        }
    }

    // 2. Machine config
    if (machineConfigPath && fs.existsSync(machineConfigPath)) {
        try {
            const raw = fs.readFileSync(machineConfigPath, 'utf8');
            const data = JSON.parse(raw);
            if (data && data.crmUrl && !crmUrl) {
                crmUrl = data.crmUrl;
                configSource = `machine:${machineConfigPath}`;
            }
            if (data && data.telephonyUrl && !telephonyUrl) {
                telephonyUrl = data.telephonyUrl;
                configSource = `machine:${machineConfigPath}`;
            }
        } catch (err) {
            console.warn('[Config] Could not parse machine config file:', err.message);
        }
    }

    // 2.5 User config (%AppData%\sokrat-crm-v2-desktop\config.json)
    if (userConfigPath && fs.existsSync(userConfigPath)) {
        try {
            const raw = fs.readFileSync(userConfigPath, 'utf8');
            const data = JSON.parse(raw);
            if (data && data.crmUrl && !crmUrl) {
                crmUrl = data.crmUrl;
                configSource = `user:${userConfigPath}`;
            }
            if (data && data.telephonyUrl && !telephonyUrl) {
                telephonyUrl = data.telephonyUrl;
                configSource = `user:${userConfigPath}`;
            }
        } catch (err) {
            console.warn('[Config] Could not parse user config file:', err.message);
        }
    }

    // 3. Packaged config
    if (packagedConfigPath && fs.existsSync(packagedConfigPath)) {
        try {
            const raw = fs.readFileSync(packagedConfigPath, 'utf8');
            const data = JSON.parse(raw);
            if (data && data.crmUrl && !crmUrl) {
                crmUrl = data.crmUrl;
                configSource = `packaged:${packagedConfigPath}`;
            }
            if (data && data.telephonyUrl && !telephonyUrl) {
                telephonyUrl = data.telephonyUrl;
                configSource = `packaged:${packagedConfigPath}`;
            }
        } catch (err) {
            console.warn('[Config] Could not parse packaged config file:', err.message);
        }
    }

    // 4. Default fallbacks
    if (!crmUrl) crmUrl = DEFAULT_CRM_URL;
    if (!telephonyUrl) telephonyUrl = DEFAULT_TELEPHONY_URL;

    const validatedCrmUrl = validateUrl(crmUrl, 'CRM URL');
    const validatedTelephonyUrl = validateUrl(telephonyUrl, 'Telephony URL');

    const isExplicitlyConfigured = ['environment', 'machine', 'user'].some(p => configSource.startsWith(p));

    return {
        crmUrl: validatedCrmUrl,
        crmOrigin: getOrigin(validatedCrmUrl),
        telephonyUrl: validatedTelephonyUrl,
        telephonyOrigin: getOrigin(validatedTelephonyUrl),
        configSource,
        isExplicitlyConfigured
    };
}

module.exports = {
    DEFAULT_CRM_URL,
    DEFAULT_TELEPHONY_URL,
    validateUrl,
    getOrigin,
    getMachineConfigPath,
    getUserConfigPath,
    saveUserConfig,
    resolveConfig
};
