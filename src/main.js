'use strict';

const path = require('path');
const {
    app,
    BrowserWindow,
    WebContentsView,
    session,
    ipcMain,
    dialog,
    Menu,
    Tray,
    powerMonitor
} = require('electron');

const { resolveConfig, saveUserConfig } = require('./config');
const {
    applySecurityPolicy,
    handleCrmNavigation,
    shouldTrustTelephonyCertificate
} = require('./security');

app.enableSandbox();

// 1. Single Instance Application Lock
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    console.log('[Sokrat CRM V2 Desktop] Another instance is already running. Exiting.');
    app.quit();
    process.exit(0);
}

let mainWindow = null;
let crmView = null;
let telephonyView = null;
let telephonyVisible = false;
let tray = null;
let forceQuit = false;
let activeCallCount = 0;
let currentRegistration = { status: 'DISCONNECTED', extension: '' };
let currentCallState = { state: 'ended' };
let setupWindow = null;

const getTelephonyBounds = (bounds) => {
    const width = 360;
    const height = Math.min(640, Math.max(200, bounds.height - 80));
    const paddingRight = 16;
    const bottomOffset = 70;
    return {
        x: Math.max(0, Math.round(bounds.width - width - paddingRight)),
        y: Math.max(0, Math.round(bounds.height - bottomOffset - height)),
        width,
        height
    };
};

function updateLayout() {
    if (!mainWindow || mainWindow.isDestroyed() || !crmView) return;
    const bounds = mainWindow.getContentBounds();
    crmView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    if (telephonyView) {
        if (telephonyVisible) {
            telephonyView.setBounds(getTelephonyBounds(bounds));
        } else {
            telephonyView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        }
    }
}

function showTelephony() {
    telephonyVisible = true;
    updateLayout();
    if (crmView && !crmView.webContents.isDestroyed()) {
        crmView.webContents.send('crm:softphone-visibility', { visible: true });
    }
}

function hideTelephony() {
    telephonyVisible = false;
    updateLayout();
    if (crmView && !crmView.webContents.isDestroyed()) {
        crmView.webContents.send('crm:softphone-visibility', { visible: false });
    }
}

function toggleTelephony() {
    if (telephonyVisible) hideTelephony();
    else showTelephony();
}

let config = resolveConfig({ allowEnv: !app.isPackaged });
console.log(`[Sokrat CRM V2 Desktop] Initialized with CRM: ${config.crmUrl} | Telephony: ${config.telephonyUrl} | Source: ${config.configSource}`);

const secureOriginsList = Array.from(new Set([
    'http://192.168.100.216',
    'http://100.81.225.5:8080',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    config.crmOrigin
].filter(Boolean))).join(',');

app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', secureOriginsList);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (
        shouldTrustTelephonyCertificate(url, error, config.telephonyOrigin) ||
        shouldTrustTelephonyCertificate(url, error, config.crmOrigin)
    ) {
        event.preventDefault();
        console.warn(`[Security] Trusted certificate for ${new URL(url).origin} (${error})`);
        callback(true);
        return;
    }

    callback(false);
});


function openSetupDialog() {
    if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.focus();
        return;
    }

    let appIcon = path.join(__dirname, '../assets/icon.ico');
    if (!require('fs').existsSync(appIcon)) {
        appIcon = path.join(__dirname, '../assets/icon.png');
    }

    setupWindow = new BrowserWindow({
        width: 580,
        height: 640,
        minWidth: 500,
        minHeight: 550,
        title: 'Sokrat CRM V2 — Connection Setup',
        icon: appIcon,
        backgroundColor: '#0f172a',
        autoHideMenuBar: true,
        resizable: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'setup-preload.js')
        }
    });

    setupWindow.loadFile(path.join(__dirname, '../assets/setup.html')).catch(() => {});
    setupWindow.on('closed', () => {
        setupWindow = null;
    });
}

function setupConfigIpc() {
    ipcMain.handle('setup:get-config', () => {
        return {
            crmUrl: config.crmUrl,
            telephonyUrl: config.telephonyUrl,
            isExplicitlyConfigured: Boolean(config.isExplicitlyConfigured)
        };
    });

    ipcMain.handle('setup:test-connection', async (_, { crmUrl, telephonyUrl }) => {
        const http = require('http');
        const https = require('https');

        function checkUrl(rawUrl, isTelephony = false) {
            return new Promise((resolve) => {
                try {
                    const parsed = new URL(rawUrl);
                    const client = parsed.protocol === 'https:' ? https : http;
                    const req = client.request({
                        method: 'HEAD',
                        protocol: parsed.protocol,
                        hostname: parsed.hostname,
                        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                        path: parsed.pathname || '/',
                        timeout: 5000,
                        rejectUnauthorized: !isTelephony
                    }, (res) => {
                        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, code: res.statusCode });
                    });
                    req.on('error', (err) => resolve({ ok: false, error: err.message }));
                    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
                    req.end();
                } catch (e) {
                    resolve({ ok: false, error: e.message });
                }
            });
        }

        const [crmRes, telRes] = await Promise.all([
            checkUrl(crmUrl, false),
            checkUrl(telephonyUrl, true)
        ]);

        return {
            crmOk: crmRes.ok,
            telephonyOk: telRes.ok,
            crmCode: crmRes.code,
            telephonyCode: telRes.code,
            error: !crmRes.ok ? `CRM Server: ${crmRes.error || crmRes.code}` : (!telRes.ok ? `VoIP Server: ${telRes.error || telRes.code}` : null)
        };
    });

    ipcMain.handle('setup:discover-endpoints', async (_, crmUrl) => {
        const http = require('http');
        const https = require('https');
        return new Promise((resolve) => {
            try {
                const parsed = new URL(crmUrl);
                const client = parsed.protocol === 'https:' ? https : http;
                const req = client.request({
                    method: 'GET',
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: '/api/voip/public-endpoints',
                    timeout: 4000,
                    headers: { 'Accept': 'application/json' }
                }, (res) => {
                    let body = '';
                    res.on('data', d => body += d);
                    res.on('end', () => {
                        try {
                            const data = JSON.parse(body);
                            resolve({ telephonyUrl: data.telephonyUrl || data.softphone_url || null });
                        } catch (_) { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
                req.end();
            } catch (_) { resolve(null); }
        });
    });

    ipcMain.handle('setup:save-config', (_, payload) => {
        try {
            const updated = saveUserConfig(payload);
            config = updated;

            if (crmView && !crmView.webContents.isDestroyed()) {
                crmView.webContents.loadURL(config.crmUrl).catch(() => {});
            }
            if (telephonyView && !telephonyView.webContents.isDestroyed()) {
                telephonyView.webContents.loadURL(config.telephonyUrl).catch(() => {});
            }

            if (setupWindow && !setupWindow.isDestroyed()) {
                setupWindow.close();
            }

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
                mainWindow.focus();
            }

            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.on('setup:cancel', () => {
        if (setupWindow && !setupWindow.isDestroyed()) {
            setupWindow.close();
        }
    });
}

function handleDeepLinkUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.startsWith('sokrat-crm-v2://')) return;
    try {
        const parsed = new URL(rawUrl);
        const crmParam = parsed.searchParams.get('crm');
        const telParam = parsed.searchParams.get('telephony') || parsed.searchParams.get('pbx');
        if (crmParam && telParam) {
            const updated = saveUserConfig({ crmUrl: crmParam, telephonyUrl: telParam });
            config = updated;
            if (crmView && !crmView.webContents.isDestroyed()) crmView.webContents.loadURL(config.crmUrl).catch(() => {});
            if (telephonyView && !telephonyView.webContents.isDestroyed()) telephonyView.webContents.loadURL(config.telephonyUrl).catch(() => {});
            if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
            if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
        }
    } catch (_) {}
}

function setupIpcRelay(crmWebContents, telephonyWebContents) {
    ipcMain.on('crm:toggle-softphone', (event) => {
        if (event.sender !== crmWebContents) return;
        toggleTelephony();
    });

    ipcMain.on('crm:open-settings', (event) => {
        openSetupDialog();
    });

    ipcMain.on('crm:show-softphone', (event) => {
        if (event.sender !== crmWebContents) return;
        showTelephony();
    });

    ipcMain.on('crm:hide-softphone', (event) => {
        if (event.sender !== crmWebContents) return;
        hideTelephony();
    });

    // 1. CRM -> Telephony: Dial Request
    ipcMain.on('crm:dial', (event, data) => {
        if (event.sender !== crmWebContents) return;
        console.log(`[Desktop Relay] Dial request for: ${data?.phone}`);
        showTelephony();
        telephonyWebContents.send('telephony:do-dial', data);
    });

    // 2. CRM -> Telephony: Call Actions (mute, hangup)
    ipcMain.on('crm:call-action', (event, data) => {
        if (event.sender !== crmWebContents) return;
        telephonyWebContents.send('telephony:do-action', data);
    });

    // 3. Telephony -> CRM: Call State Update
    ipcMain.on('telephony:state-change', (event, data) => {
        if (event.sender !== telephonyWebContents) return;
        currentCallState = data;
        const state = data?.state;
        if (state === 'in_call' || state === 'confirmed' || state === 'accepted') {
            activeCallCount = 1;
        } else if (state === 'ended' || state === 'failed') {
            activeCallCount = 0;
        }
        if (data?.startTime) {
            currentCallState.startTime = data.startTime;
        }
        crmWebContents.send('crm:sync-state', data);
    });

    // 3.5 Telephony -> CRM: Timer Sync
    ipcMain.on('telephony:timer-sync', (event, data) => {
        if (event.sender !== telephonyWebContents) return;
        crmWebContents.send('crm:sync-timer', data);
    });

    // 4. Telephony -> CRM: Incoming Call
    ipcMain.on('telephony:incoming-call', (event, data) => {
        if (event.sender !== telephonyWebContents) return;
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }

        showTelephony();
        crmWebContents.send('crm:show-incoming', data);
    });

    // 5. Telephony -> CRM: Registration Status
    ipcMain.on('telephony:registration-status', (event, data) => {
        if (event.sender !== telephonyWebContents) return;
        currentRegistration = data;
        crmWebContents.send('crm:sync-registration', data);
    });
}

function setupTray() {
    try {
        let iconPath = path.join(__dirname, '../assets/icon.png');
        if (!require('fs').existsSync(iconPath)) {
            iconPath = path.join(__dirname, '../assets/icon.ico');
        }
        tray = new Tray(iconPath);
        tray.setToolTip('Sokrat CRM V2');

        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Open Sokrat CRM V2',
                click: () => {
                    if (mainWindow) {
                        if (mainWindow.isMinimized()) mainWindow.restore();
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
            },
            {
                label: 'Server Settings...',
                click: () => openSetupDialog()
            },
            { type: 'separator' },
            {
                label: 'Quit',
                click: () => {
                    forceQuit = true;
                    app.quit();
                }
            }
        ]);

        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => {
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        });
    } catch (err) {
        console.warn('[Desktop Tray] Could not initialize tray:', err.message);
    }
}

async function createApplication() {
    app.setAppUserModelId('com.sokrat.crm-v2');

    // Auto-startup on Windows login
    app.setLoginItemSettings({ openAtLogin: true, name: 'Sokrat CRM V2' });

    const crmSession = session.fromPartition('persist:sokrat-crm-v2');
    const telephonySession = crmSession; // Shared partition for zero-auth CRM telephony

    applySecurityPolicy(crmSession, telephonySession, config);

    // Resolve icon
    let appIcon = path.join(__dirname, '../assets/icon.ico');
    if (!require('fs').existsSync(appIcon)) {
        appIcon = path.join(__dirname, '../assets/icon.png');
    }

    // Application Menu with shortcuts
    const menuTemplate = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Server Connection Settings (LAN / VPN)...',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => openSetupDialog()
                },
                { type: 'separator' },
                {
                    label: 'Exit',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        forceQuit = true;
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Settings',
            submenu: [
                {
                    label: 'Configure Server IP (F2)...',
                    accelerator: 'F2',
                    click: () => openSetupDialog()
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

    // IPC handler for registration state query from crm-preload
    ipcMain.handle('telephony:get-registration', () => currentRegistration);

    // 1. Primary Desktop Window
    mainWindow = new BrowserWindow({
        width: 1366,
        height: 850,
        minWidth: 1024,
        minHeight: 700,
        title: 'Sokrat CRM V2',
        icon: appIcon,
        backgroundColor: '#0f172a',
        show: false
    });

    // 2. Navigable CRM View (Where agent works)
    crmView = new WebContentsView({
        webPreferences: {
            session: crmSession,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'crm-preload.js'),
            backgroundThrottling: false,
            spellcheck: false
        }
    });

    crmView.webContents.on('console-message', (event, level, message, line, sourceId) => {
        const text = (event && typeof event === 'object' && event.message !== undefined) ? event.message : message;
        const src = (event && typeof event === 'object' && event.sourceId !== undefined) ? event.sourceId : sourceId;
        const ln = (event && typeof event === 'object' && event.lineNumber !== undefined) ? event.lineNumber : line;
        console.log(`[CRM Console] ${text} (${src}:${ln})`);
    });

    // 3. Persistent Telephony View (embedded directly in CRM window, persistent across CRM navigations)
    telephonyView = new WebContentsView({
        webPreferences: {
            session: telephonySession,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'telephony-preload.js'),
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required',
            spellcheck: false
        }
    });
    telephonyView.setBackgroundColor('#09090d');

    telephonyView.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        console.error(`[Telephony Load Failed] Code: ${errorCode} | Desc: ${errorDescription} | URL: ${validatedURL}`);
    });

    telephonyView.webContents.on('did-finish-load', () => {
        console.log(`[Desktop] Telephony runtime loaded: ${telephonyView.webContents.getURL()}`);
    });

    telephonyView.webContents.on('console-message', (event, level, message, line, sourceId) => {
        const text = (event && typeof event === 'object' && event.message !== undefined) ? event.message : message;
        const src = (event && typeof event === 'object' && event.sourceId !== undefined) ? event.sourceId : sourceId;
        const ln = (event && typeof event === 'object' && event.lineNumber !== undefined) ? event.lineNumber : line;
        console.log(`[Telephony Console] ${text} (${src}:${ln})`);
    });

    telephonyView.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(config.telephonyOrigin) && !url.startsWith(config.crmOrigin)) {
            e.preventDefault();
        }
    });
    telephonyView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    mainWindow.contentView.addChildView(crmView);
    mainWindow.contentView.addChildView(telephonyView);

    mainWindow.on('resize', updateLayout);
    updateLayout();

    // Navigation filtering for CRM view
    crmView.webContents.on('will-navigate', (event, url) => {
        handleCrmNavigation(event, url, config.crmOrigin);
    });

    // Open any target=_blank or window.open CRM links in the SAME window
    crmView.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url);
            if (parsed.origin === config.crmOrigin) {
                crmView.webContents.loadURL(url).catch(() => {});
                return { action: 'deny' };
            }
            if (['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
                const { shell } = require('electron');
                shell?.openExternal(url).catch(() => {});
            }
        } catch (_) {}
        return { action: 'deny' };
    });

    // Instantly push active telephony registration & call state to newly navigated CRM pages
    crmView.webContents.on('did-finish-load', () => {
        const crmUrl = crmView.webContents.getURL();
        if (crmUrl && !crmUrl.includes('/login') && config.crmUrl && crmUrl.startsWith(config.crmOrigin)) {
            const embedSoftphoneUrl = `${config.crmOrigin}/voip/softphone`;
            const currentTelUrl = telephonyView.webContents.getURL();
            if (!currentTelUrl || currentTelUrl === 'about:blank' || currentTelUrl.includes('/login') || !currentTelUrl.includes('/phone/embed')) {
                console.log(`[Desktop] Booting CRM-authenticated telephony runtime: ${embedSoftphoneUrl}`);
                telephonyView.webContents.loadURL(embedSoftphoneUrl).catch(() => {});
            }
        }

        if (currentRegistration && currentRegistration.status) {
            crmView.webContents.send('crm:sync-registration', currentRegistration);
        }
        if (currentCallState && currentCallState.state && currentCallState.state !== 'ended') {
            crmView.webContents.send('crm:sync-state', currentCallState);
        }
        crmView.webContents.send('crm:softphone-visibility', { visible: telephonyVisible });
    });

    // Wire IPC relay between CRM and Telephony
    setupIpcRelay(crmView.webContents, telephonyView.webContents);
    setupTray();
    setupConfigIpc();

    // Handle Window close -> minimize to tray unless force quitting
    mainWindow.on('close', (event) => {
        if (!forceQuit) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // Load persistent telephony session with fallback
    const initialTelephonyUrl = `${config.crmOrigin}/voip/softphone`;
    console.log(`[Desktop] Spawning telephony runtime: ${initialTelephonyUrl}`);
    telephonyView.webContents.loadURL(initialTelephonyUrl).catch(() => {
        telephonyView.webContents.loadURL(config.telephonyUrl).catch(() => {});
    });

    // Load CRM interface in main view
    console.log(`[Desktop] Loading CRM view: ${config.crmUrl}`);
    crmView.webContents.loadURL(config.crmUrl).catch(err => {
        console.error('[Desktop] CRM view load error:', err.message);
    });

    if (!config.isExplicitlyConfigured) {
        openSetupDialog();
    } else {
        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
        });
    }

    // Notify upon OS resume from sleep
    powerMonitor.on('resume', () => {
        if (telephonyView && !telephonyView.webContents.isDestroyed()) {
            telephonyView.webContents.send('telephony:resume');
        }
    });
}

// Register custom enterprise protocol client: sokrat-crm-v2://
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('sokrat-crm-v2', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('sokrat-crm-v2');
}

// Handle second instance launch: bring existing window to front & handle deep links
app.on('second-instance', (event, commandLine) => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
    if (Array.isArray(commandLine)) {
        const uri = commandLine.find(arg => typeof arg === 'string' && arg.startsWith('sokrat-crm-v2://'));
        if (uri) handleDeepLinkUrl(uri);
    }
});

app.whenReady().then(createApplication);

const initialDeepLink = process.argv.find(arg => typeof arg === 'string' && arg.startsWith('sokrat-crm-v2://'));
if (initialDeepLink) handleDeepLinkUrl(initialDeepLink);

// Protect against accidental termination during active phone calls
app.on('before-quit', (event) => {
    if (activeCallCount > 0 && !forceQuit) {
        event.preventDefault();
        const choice = dialog.showMessageBoxSync(mainWindow || undefined, {
            type: 'warning',
            buttons: ['Keep Calls Active', 'End Calls & Quit'],
            defaultId: 0,
            cancelId: 0,
            title: 'Active Call in Progress',
            message: 'You have an active telephone call in Sokrat CRM V2. Quitting now will terminate the call.',
            detail: 'Are you sure you want to hang up and exit?'
        });

        if (choice === 1) {
            forceQuit = true;
            app.quit();
        }
    }
});

app.on('window-all-closed', () => {
    // Keep app running in system tray
});
