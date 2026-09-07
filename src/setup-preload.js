'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const setupBridge = Object.freeze({
    getConfig() {
        return ipcRenderer.invoke('setup:get-config');
    },

    testConnection(payload) {
        return ipcRenderer.invoke('setup:test-connection', payload);
    },

    discoverEndpoints(crmUrl) {
        return ipcRenderer.invoke('setup:discover-endpoints', crmUrl);
    },

    saveConfig(payload) {
        return ipcRenderer.invoke('setup:save-config', payload);
    },

    cancel() {
        ipcRenderer.send('setup:cancel');
    }
});

try {
    contextBridge.exposeInMainWorld('sokratSetup', setupBridge);
} catch (err) {
    console.error('[Setup Preload] Failed to expose sokratSetup bridge:', err);
}
