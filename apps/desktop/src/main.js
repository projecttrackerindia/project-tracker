'use strict';
const { app, BrowserWindow, Menu, Tray, Notification, shell, nativeImage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { appUrl, RELEASES_API, DOWNLOAD_PAGE } = require('./config');
const { deepLinkToUrl, isInternal, unreadFromTitle, isNewer } = require('./links');

const BASE = appUrl();
let win = null, tray = null, quitting = false, pendingLink = null;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { width: 1280, height: 820 }; }
}
function saveState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* not worth stopping for */ }
}

function showOffline() {
  const html = `<!doctype html><meta charset="utf-8"><title>Project Tracker</title><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f4f1fb;color:#221a3a"><div style="text-align:center;max-width:380px"><h2>You are offline</h2><p>Project Tracker could not reach ${BASE}. Check your connection; it will reconnect on its own.</p><button onclick="location.href='${BASE}'" style="padding:10px 18px;border:0;border-radius:10px;background:#7c3aed;color:#fff;font-size:15px;cursor:pointer">Try again</button></div>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width, height: st.height, x: st.x, y: st.y, minWidth: 420, minHeight: 600, show: false, backgroundColor: '#f4f1fb', title: 'Project Tracker',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(BASE).catch(() => undefined);
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => { if (isMain && code !== -3 && url.startsWith(BASE)) showOffline(); });

  // Pages of the app stay in the window; everything else opens in the person's own browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (isInternal(url, BASE)) return { action: 'allow' }; if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isInternal(url, BASE) && !url.startsWith('data:')) { e.preventDefault(); if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); } });

  // The unread count in the page title becomes the badge on the dock / taskbar / tray.
  win.webContents.on('page-title-updated', (_e, title) => {
    const n = unreadFromTitle(title);
    app.setBadgeCount(n);
    if (tray) tray.setToolTip(n > 0 ? `Project Tracker (${n} unread)` : 'Project Tracker');
    if (process.platform === 'win32' && win) win.setOverlayIcon(null, '');
  });

  win.on('resize', saveState); win.on('move', saveState); win.on('close', (e) => {
    saveState();
    if (!quitting && process.platform !== 'darwin' && tray) { e.preventDefault(); win.hide(); }   // closing keeps it running in the tray, like a chat app
  });
  if (pendingLink) { open(pendingLink); pendingLink = null; }
}

function open(link) {
  const url = deepLinkToUrl(link, BASE);
  if (!url) return;
  if (!win) { pendingLink = link; return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus(); win.loadURL(url).catch(() => undefined);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Project Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Project Tracker', click: () => { win.show(); win.focus(); } },
    { label: 'My work', click: () => open('projecttracker://my-work') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { if (win.isVisible()) win.focus(); else win.show(); });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Open in browser', click: () => shell.openExternal(BASE) }, { label: 'Check for updates', click: () => checkUpdates(true) }, { label: 'Downloads page', click: () => shell.openExternal(DOWNLOAD_PAGE) }] },
  ]));
}

/** Looks at the latest published release and says so when it is newer. It only tells; installing is the person's choice (the download page has the installer). */
async function checkUpdates(manual) {
  try {
    const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(String(res.status));
    const latest = (await res.json()).tag_name;
    if (latest && isNewer(latest, app.getVersion())) {
      const n = new Notification({ title: 'A new version of Project Tracker is available', body: `Version ${String(latest).replace(/^v/, '')} is ready to download.` });
      n.on('click', () => shell.openExternal(DOWNLOAD_PAGE)); n.show();
    } else if (manual) new Notification({ title: 'Project Tracker is up to date', body: `You have version ${app.getVersion()}.` }).show();
  } catch { if (manual) new Notification({ title: 'Could not check for updates', body: 'Try again when you are online.' }).show(); }
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (_e, argv) => { const link = argv.find((a) => a.startsWith('projecttracker://')); if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } if (link) open(link); });
  app.on('open-url', (e, link) => { e.preventDefault(); open(link); });   // macOS
  app.setAsDefaultProtocolClient('projecttracker');

  app.whenReady().then(() => {
    // The page's own permission prompts (notifications, clipboard) are allowed for the app itself and nobody else.
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(isInternal(wc.getURL(), BASE) && ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'media'].includes(permission)));
    buildMenu(); createWindow(); if (process.platform !== 'darwin') createTray();
    setTimeout(() => checkUpdates(false), 15000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else win.show(); });
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
}
