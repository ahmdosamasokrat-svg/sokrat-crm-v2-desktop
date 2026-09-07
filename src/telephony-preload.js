'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let voiceBus = null;
try {
    voiceBus = new BroadcastChannel('sokrat_softphone_bus');
} catch (_) {}

// 1. Receive Dial Commands from Electron Main -> dispatch to Softphone
ipcRenderer.on('telephony:do-dial', (_, data) => {
    const phone = data?.phone;
    if (!phone) return;

    // Dispatch via BroadcastChannel
    if (voiceBus) {
        voiceBus.postMessage({
            type: 'CLICK_TO_CALL',
            number: phone,
            autoCall: true
        });
    }

    // Also dispatch to window
    window.postMessage({
        type: 'CLICK_TO_CALL',
        number: phone,
        autoCall: true
    }, '*');
});

// 2. Receive Call Actions (Mute, Hangup) from Electron Main -> dispatch to Softphone
ipcRenderer.on('telephony:do-action', (_, data) => {
    const action = data?.action;
    if (!action) return;

    try {
        if (window.softphoneUi && window.softphoneUi.core) {
            if (action === 'hangup') {
                window.softphoneUi.core.hangupAllCalls();
            } else if (action === 'toggle_mute') {
                const call = Array.from(window.softphoneUi.core.activeCalls.values())[0];
                if (call) window.softphoneUi.core.toggleMute(call.id);
            }
        }
    } catch (_) {}

    window.postMessage({
        version: 1,
        type: action === 'toggle_mute' ? 'sokrat.voice.toggle_mute' :
              action === 'hangup' ? 'sokrat.voice.hangup' : action
    }, '*');
});

// 3. Listen for events emitted by Softphone page -> forward to Electron Main
window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    const type = msg.type;
    const payload = msg.payload || {};

    if (type === 'sokrat.voice.registration') {
        ipcRenderer.send('telephony:registration-status', {
            status: payload.state || 'DISCONNECTED',
            extension: payload.extension || ''
        });
    } else if (type === 'sokrat.voice.incoming') {
        ipcRenderer.send('telephony:incoming-call', {
            phone: payload.phone || payload.target || 'Unknown',
            callId: payload.callId || null
        });
    } else if (type === 'sokrat.voice.call_state') {
        ipcRenderer.send('telephony:state-change', {
            state: payload.state,
            callId: payload.callId,
            phone: payload.phone,
            startTime: payload.startTime
        });
    } else if (type === 'sokrat.voice.timer_sync') {
        ipcRenderer.send('telephony:timer-sync', {
            seconds: payload.seconds,
            formatted: payload.formatted
        });
    } else if (type === 'sokrat.voice.collapse') {
        ipcRenderer.send('crm:hide-softphone');
    }
});

// Expose safe host methods to the page
contextBridge.exposeInMainWorld('sokratTelephonyHost', {
    minimize() {
        ipcRenderer.send('crm:hide-softphone');
    },
    notifyRegistration(status, extension) {
        ipcRenderer.send('telephony:registration-status', { status, extension });
    },
    notifyCallState(state, payload = {}) {
        ipcRenderer.send('telephony:state-change', { state, ...payload });
    },
    notifyIncoming(phone, callId) {
        ipcRenderer.send('telephony:incoming-call', { phone, callId });
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.querySelector('.modal-backdrop:not(.hidden)');
        if (!modal) {
            ipcRenderer.send('crm:hide-softphone');
        }
    }
});
