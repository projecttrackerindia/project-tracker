'use strict';
const { app, BrowserWindow, Menu, Tray, Notification, shell, nativeImage, nativeTheme, session, globalShortcut, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { appUrl, RELEASES_API, DOWNLOAD_PAGE } = require('./config');
const { deepLinkToUrl, isInternal, unreadFromTitle, isNewer } = require('./links');

const BASE = appUrl();
let win = null, tray = null, quitting = false, pendingLink = null;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';

/** What the person chose in the tray menu. Kept in a small file next to the window state. */
const defaults = { keepRunning: true, startHidden: false };
function settings() { try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...defaults }; } }
function saveSettings(patch) { try { fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings(), ...patch })); } catch { /* not worth stopping for */ } }
const UA_MARK = () => `ProjectTrackerDesktop/${app.getVersion()}`;

/** Goes to a page of the app without reloading it (the app's own router handles the address). */
function go(route) {
  if (!win) return;
  win.show(); win.focus();
  win.webContents.executeJavaScript(`(function(){history.pushState({}, '', ${JSON.stringify(route)});dispatchEvent(new PopStateEvent('popstate'));})()`).catch(() => undefined);
}
/** The page's own search ("/" focuses it): one shortcut anywhere on the computer opens the app ready to search. */
function quickSearch() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'/',bubbles:true}))`).catch(() => undefined);
}

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
    width: st.width, height: st.height, x: st.x, y: st.y, minWidth: 1000, minHeight: 620, show: false, title: 'Project Tracker',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0c1d' : '#f4f1fb',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // Windows: the app's own top bar is the title bar, with the system's window buttons on top of it. Mac and Linux keep the system's.
    ...(WIN ? { frame: false } : {}),   // Windows: no system title bar; the app draws its own top bar and window buttons
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setUserAgent(`${win.webContents.getUserAgent().replace(/ Electron\/\S+/, '')} ${UA_MARK()}`);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!(settings().startHidden && process.argv.includes('--hidden') && tray)) win.show(); });
  // It opens at sign-in (or straight into the workspace when already signed in), never at the public website.
  win.loadURL(`${BASE}/login`).catch(() => undefined);
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => { if (isMain && code !== -3 && url.startsWith(BASE)) showOffline(); });

  // Pages of the app stay in the window; everything else opens in the person's own browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (isInternal(url, BASE)) return { action: 'allow' }; if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isInternal(url, BASE) && !url.startsWith('data:')) { e.preventDefault(); if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); } });

  // The unread count in the page title becomes the badge on the dock / taskbar / tray.
  win.webContents.on('page-title-updated', (_e, title) => {
    const n = unreadFromTitle(title);
    app.setBadgeCount(n);
    if (tray) tray.setToolTip(n > 0 ? `Project Tracker (${n} unread)` : 'Project Tracker');
    if (WIN && win) overlayBadge(n);
  });
  win.webContents.on('context-menu', (_e, p) => contextMenu(p));
  win.webContents.session.on('will-download', (_e, item) => {
    item.once('done', (_ev, state) => { if (state === 'completed') { const n = new Notification({ title: 'Download finished', body: item.getFilename() }); n.on('click', () => shell.showItemInFolder(item.getSavePath())); n.show(); } });
  });

  win.on('maximize', () => win.webContents.send('win-maximized', true)); win.on('unmaximize', () => win.webContents.send('win-maximized', false));
  win.on('resize', saveState); win.on('move', saveState); win.on('close', (e) => {
    saveState();
    if (!quitting && !MAC && tray && settings().keepRunning) { e.preventDefault(); win.hide(); }   // closing keeps it running in the tray, like a chat app
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

/** Windows has no badge number: a small red dot with the count is drawn by the page and put on the taskbar button. */
async function overlayBadge(n) {
  if (!win || win.isDestroyed()) return;
  if (n <= 0) { win.setOverlayIcon(null, ''); return; }
  try {
    const url = await win.webContents.executeJavaScript(`(function(){var c=document.createElement('canvas');c.width=c.height=32;var x=c.getContext('2d');x.fillStyle='#e11d48';x.beginPath();x.arc(16,16,15,0,7);x.fill();x.fillStyle='#fff';x.font='bold '+(${n} > 9 ? 17 : 21)+'px sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(${n} > 99 ? '99+' : String(${n}),16,17);return c.toDataURL('image/png');})()`);
    win.setOverlayIcon(nativeImage.createFromDataURL(url), `${n} unread`);
  } catch { /* the badge is a nicety */ }
}

/** Right-click: spelling suggestions, copy and paste, and links and images. */
function contextMenu(p) {
  const items = [];
  if (p.misspelledWord) {
    for (const w of p.dictionarySuggestions.slice(0, 5)) items.push({ label: w, click: () => win.webContents.replaceMisspelling(w) });
    items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
  }
  if (p.linkURL) items.push({ label: 'Open link in browser', click: () => shell.openExternal(p.linkURL) }, { label: 'Copy link address', click: () => require('electron').clipboard.writeText(p.linkURL) }, { type: 'separator' });
  if (p.mediaType === 'image') items.push({ label: 'Copy image', click: () => win.webContents.copyImageAt(p.x, p.y) }, { label: 'Save image as…', click: () => win.webContents.downloadURL(p.srcURL) }, { type: 'separator' });
  if (p.isEditable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  else if (p.selectionText) items.push({ role: 'copy' });
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Project Tracker');
  const build = () => Menu.buildFromTemplate([
    { label: 'Open Project Tracker', click: () => { win.show(); win.focus(); } },
    { label: 'Search…', accelerator: 'CommandOrControl+Shift+Space', click: quickSearch },
    { label: 'My work', click: () => go('/my-work') },
    { label: 'Reminders', click: () => go('/reminders') },
    { type: 'separator' },
    { label: 'Start when I sign in to my computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }); saveSettings({ startHidden: i.checked }); } },
    { label: 'Keep running in the tray when the window is closed', type: 'checkbox', checked: settings().keepRunning, click: (i) => saveSettings({ keepRunning: i.checked }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(build());
  tray.on('click', () => { if (win.isVisible()) win.focus(); else win.show(); });
}

function buildMenu() {
  const nav = (label, route, key) => ({ label, accelerator: `CommandOrControl+${key}`, click: () => go(route) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(MAC ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Search…', accelerator: 'CommandOrControl+K', click: quickSearch },
      { label: 'Account settings', accelerator: 'CommandOrControl+,', click: () => go('/account') },
      { type: 'separator' },
      MAC ? { role: 'close' } : { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => { quitting = true; app.quit(); } },
    ] },
    { role: 'editMenu' },
    { label: 'Go', submenu: [
      nav('Dashboard', '/', '1'), nav('My work', '/my-work', '2'), nav('Projects', '/projects', '3'), nav('Chat', '/chat', '4'),
      nav('Reminders', '/reminders', '5'), nav('Calendar', '/calendar', '6'), nav('Assistant', '/ai', '7'),
      { type: 'separator' },
      { label: 'Back', accelerator: 'Alt+Left', click: () => win && win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => win && win.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Open in browser', click: () => shell.openExternal(BASE) }, { label: 'Check for updates', click: () => checkUpdates(true) }, { label: 'Downloads page', click: () => shell.openExternal(DOWNLOAD_PAGE) }, { type: 'separator' }, { label: `Version ${app.getVersion()}`, enabled: false }] },
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
    if (WIN) app.setAppUserModelId('in.projecttracker.desktop');   // so notifications carry the app's name and icon
    ipcMain.on('win-control', (e, action) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
      else if (action === 'close') win.close();
      else if (action === 'query') win.webContents.send('win-maximized', win.isMaximized());
    });
    buildMenu(); if (!MAC) createTray(); createWindow();
    globalShortcut.register('CommandOrControl+Shift+Space', quickSearch);
    setTimeout(() => checkUpdates(false), 15000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else win.show(); });
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
}
