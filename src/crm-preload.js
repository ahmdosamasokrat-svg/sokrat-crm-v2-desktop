'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const crmBridge = Object.freeze({
    isDesktop: true,
    version: '1.0.0',

    toggleSoftphone() {
        ipcRenderer.send('crm:toggle-softphone');
    },

    showSoftphone() {
        ipcRenderer.send('crm:show-softphone');
    },

    hideSoftphone() {
        ipcRenderer.send('crm:hide-softphone');
    },

    openSettings() {
        ipcRenderer.send('crm:open-settings');
    },

    onSoftphoneVisibility(callback) {
        if (typeof callback === 'function') {
            ipcRenderer.on('crm:softphone-visibility', (_, data) => {
                try { callback(data); } catch (e) { console.error('[CRM Bridge] onSoftphoneVisibility error:', e); }
            });
        }
    },

    dial(phone, leadName) {
        if (!phone) return;
        ipcRenderer.send('crm:dial', {
            phone: String(phone).trim(),
            leadName: leadName ? String(leadName).trim() : ''
        });
    },

    callAction(action, callId) {
        if (!action) return;
        ipcRenderer.send('crm:call-action', {
            action: String(action).trim(),
            callId: callId ? String(callId).trim() : null
        });
    },

    onCallState(callback) {
        if (typeof callback === 'function') {
            ipcRenderer.on('crm:sync-state', (_, data) => {
                try { callback(data); } catch (e) { console.error('[CRM Bridge] onCallState error:', e); }
            });
        }
    },

    onIncomingCall(callback) {
        if (typeof callback === 'function') {
            ipcRenderer.on('crm:show-incoming', (_, data) => {
                try { callback(data); } catch (e) { console.error('[CRM Bridge] onIncomingCall error:', e); }
            });
        }
    },

    onRegistrationStatus(callback) {
        if (typeof callback === 'function') {
            ipcRenderer.on('crm:sync-registration', (_, data) => {
                try { callback(data); } catch (e) { console.error('[CRM Bridge] onRegistrationStatus error:', e); }
            });
        }
    },

    onTimerSync(callback) {
        if (typeof callback === 'function') {
            ipcRenderer.on('crm:sync-timer', (_, data) => {
                try { callback(data); } catch (e) { console.error('[CRM Bridge] onTimerSync error:', e); }
            });
        }
    },

    isRegistered() {
        return ipcRenderer.invoke('telephony:get-registration');
    },
});

try {
    contextBridge.exposeInMainWorld('sokratDesktop', crmBridge);
} catch (err) {
    console.error('[CRM Preload] Failed to expose sokratDesktop bridge:', err);
}

ipcRenderer.on('crm:sync-timer', (_, data) => {
    window.postMessage({
        version: 1,
        type: 'sokrat.voice.timer_sync',
        payload: data
    }, '*');
});

window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        ipcRenderer.send('crm:open-settings');
    } else if (e.key === 'F2') {
        e.preventDefault();
        ipcRenderer.send('crm:open-settings');
    }
});
