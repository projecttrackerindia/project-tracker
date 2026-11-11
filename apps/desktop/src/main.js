'use strict';
const { app, BrowserWindow, Menu, Tray, Notification, shell, nativeImage, nativeTheme, session, globalShortcut, ipcMain, net, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { appUrl, RELEASES_API, DOWNLOAD_PAGE } = require('./config');
const { autoUpdater } = require('electron-updater');
const { deepLinkToUrl, isInternal, unreadFromTitle, isNewer, clampBadge } = require('./links');
const quick = require('./quick');
const { startErrorReporting } = require('./errors');

// Alert sounds must play while the window is hidden in the tray or nobody has clicked yet: the page's timers and audio keep running.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const BASE = appUrl();
// Main-process errors go to the server's error relay (off unless the server has a DSN); see docs/ops.md › Error tracking.
startErrorReporting({ base: BASE, release: `desktop-${app.getVersion()}` });
let win = null, tray = null, quitting = false, pendingLink = null;
/** The page's notifications still on screen, by tag (so a repeat replaces, and reading closes them). */
const shown = new Map();
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';

/** What the person chose in the tray menu. Kept in a small file next to the window state. */
const DEFAULT_ZOOM = 1; // Keep text and editing controls at their intended size; preserve saved user zoom.
const defaults = { keepRunning: true, startHidden: false, zoom: DEFAULT_ZOOM, shieldAlways: false };
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

/**
 * Screen-share shield. The page turns it on while a screen with secrets is open (the password vault); the person can also keep the whole
 * window out of sharing all the time. Windows excludes the window from every capture (shares and recordings show black); on a Mac the
 * window is marked not shareable, which many (not all) capture tools honour. Linux has no such switch.
 */
const CAN_SHIELD = WIN || MAC;
let pageShield = false;
function applyShield() {
  if (!CAN_SHIELD || !win || win.isDestroyed()) return;
  try { win.setContentProtection(!!(settings().shieldAlways || pageShield)); } catch { /* an older system without it */ }
}
const shieldMenuItem = () => ({ label: 'Hide this window from screen sharing at all times', type: 'checkbox', checked: settings().shieldAlways,
  click: (i) => { saveSettings({ shieldAlways: i.checked }); applyShield(); rebuildTray(); buildMenu(); } });

function setZoom(z) { const v = Math.min(1.5, Math.max(0.6, Math.round(z * 100) / 100)); saveSettings({ zoom: v }); win?.webContents.setZoomFactor(v); }
function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width, height: st.height, x: st.x, y: st.y, minWidth: 1000, minHeight: 620, show: false, title: 'Project Tracker',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0c1d' : '#f4f1fb',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // Windows: the app's own top bar is the title bar, with the system's window buttons on top of it. Mac and Linux keep the system's.
    ...(WIN ? { frame: false } : {}),   // Windows: no system title bar; the app draws its own top bar and window buttons
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  applyShield();
  // A new page (a reload, a new sign-in) asks again for the shield if it shows secrets; one that does not leaves it off.
  win.webContents.on('did-navigate', () => { pageShield = false; applyShield(); pageBadges = false; });
  win.on('focus', () => win.flashFrame(false));
  win.webContents.setUserAgent(`${win.webContents.getUserAgent().replace(/ Electron\/\S+/, '')} ${UA_MARK()}`);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!(settings().startHidden && process.argv.includes('--hidden') && tray)) win.show(); });
  // It opens at sign-in (or straight into the workspace when already signed in), never at the public website.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(settings().zoom));
  win.loadURL(`${BASE}/login`).catch(() => undefined);
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => { if (isMain && code !== -3 && url.startsWith(BASE)) showOffline(); });

  // Pages of the app stay in the window; everything else opens in the person's own browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (isInternal(url, BASE)) return { action: 'allow' }; if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // The offline page is loaded by this process (loadURL does not pass through here), so no page may navigate the window to a data: or other URL.
  win.webContents.on('will-navigate', (e, url) => { if (!isInternal(url, BASE)) { e.preventDefault(); if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); } });

  // The unread count becomes the badge on the dock / taskbar / tray: the page says it exactly (ptDesktop.setBadge, the Notification Centre's
  // number); the count at the start of the page title is the fallback for older pages. The window keeps running hidden in the tray (or, on a
  // Mac, hidden behind the dock icon), so the badge stays live while signed in even with no window on screen.
  win.webContents.on('page-title-updated', (_e, title) => { if (!pageBadges) showBadge(unreadFromTitle(title)); });
  win.webContents.on('context-menu', (_e, p) => contextMenu(p));
  win.webContents.session.on('will-download', (_e, item) => {
    item.once('done', (_ev, state) => { if (state === 'completed') { const n = new Notification({ title: 'Download finished', body: item.getFilename() }); n.on('click', () => shell.showItemInFolder(item.getSavePath())); n.show(); } });
  });

  win.on('maximize', () => win.webContents.send('win-maximized', true)); win.on('unmaximize', () => win.webContents.send('win-maximized', false));
  win.on('resize', saveState); win.on('move', saveState); win.on('close', (e) => {
    saveState();
    if (!quitting && !MAC && tray && settings().keepRunning) { e.preventDefault(); win.hide(); }   // closing keeps it running in the tray, like a chat app
    else if (!quitting && MAC) { e.preventDefault(); win.hide(); }   // a Mac app stays in the dock: hidden, still signed in, the badge still live
  });
  if (pendingLink) { open(pendingLink); pendingLink = null; }
}

/** The one-time keys of the quick-action notices still on screen, by tag (kept in memory only, never on disk). */
const quickKeys = new Map();
/** A button on a native notice: act through the one-time key with the window closed; open the app when it must finish there. */
async function pressQuick(tag, action, text) {
  const k = quickKeys.get(tag);
  if (!k) return;
  const plan = quick.pressPlan(action, text);
  const post = (body) => net.fetch(new URL(`/api/v1/notification-actions/${encodeURIComponent(k.qa)}`, BASE).href, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit',
  });
  if (plan.prompt) { replyCard(tag, action, k); return; }
  if (plan.body && plan.open) post(plan.body).catch(() => undefined);
  if (plan.open) { go(k.link); return; }
  quickKeys.delete(tag);
  try { const res = await post(plan.body); if (!res.ok) go(k.link); } catch { go(k.link); }
}
/** Reply / Reject from a Windows toast: a small card beside the tray takes the words, then sends through the key (the main window stays put). */
let card = null;
function replyCard(tag, action, k) {
  if (card && !card.isDestroyed()) card.close();
  const wa = screen.getPrimaryDisplay().workArea, w = 360, h = 186;
  card = new BrowserWindow({ width: w, height: h, x: wa.x + wa.width - w - 12, y: wa.y + wa.height - h - 12, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    title: action === 'reject' ? 'Reject' : 'Reply', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'reply-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const me = card;
  me.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  me.webContents.on('will-navigate', (e) => e.preventDefault());
  const html = quick.replyCardHtml({ action, title: k.title || 'Project Tracker', body: k.body || '', dark: nativeTheme.shouldUseDarkColors });
  me.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
  me.once('ready-to-show', () => { me.show(); me.focus(); });
  const onSend = (e, text) => { if (e.sender !== me.webContents) return; done(); me.close(); void pressQuick(tag, action, String(text || '')); };
  const onCancel = (e) => { if (e.sender !== me.webContents) return; done(); me.close(); };
  const done = () => { ipcMain.removeListener('reply-send', onSend); ipcMain.removeListener('reply-cancel', onCancel); };
  ipcMain.on('reply-send', onSend); ipcMain.on('reply-cancel', onCancel);
  me.on('closed', () => { done(); if (card === me) card = null; });
}
function open(link) {
  const q = quick.parseQuickLink(link);
  if (q) { if (q.action === 'open') { const k = quickKeys.get(q.tag); go(k ? k.link : '/'); } else void pressQuick(q.tag, q.action); return; }
  const url = deepLinkToUrl(link, BASE);
  if (!url) return;
  if (!win) { pendingLink = link; return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus(); win.loadURL(url).catch(() => undefined);
}

/** The tray / menu-bar mini window: Today, the next meeting with Join, the check-in ring, quick add (the app's /mini page). */
let mini = null;
function createMini() {
  mini = new BrowserWindow({ width: 360, height: 520, show: false, frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff', roundedCorners: true, vibrancy: MAC ? 'popover' : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  mini.loadURL(new URL('/mini', BASE).href).catch(() => undefined);
  mini.on('blur', () => { if (mini && !mini.webContents.isDevToolsOpened()) mini.hide(); });
  mini.on('closed', () => { mini = null; });
}
function toggleMini() {
  if (!mini || mini.isDestroyed()) createMini();
  if (mini.isVisible()) { mini.hide(); return; }
  // Next to the tray icon (menu bar on macOS, taskbar corner on Windows), inside the screen.
  const t = tray ? tray.getBounds() : null;
  const area = screen.getDisplayNearestPoint(t ? { x: t.x, y: t.y } : screen.getCursorScreenPoint()).workArea;
  const [w, h] = mini.getSize();
  const x = Math.round(Math.min(Math.max((t ? t.x + t.width / 2 : area.x + area.width) - w / 2, area.x + 8), area.x + area.width - w - 8));
  const y = t && t.y < area.y + area.height / 2 ? area.y + 6 : area.y + area.height - h - 6;
  mini.setPosition(x, y, false);
  mini.show(); mini.focus();
  mini.webContents.executeJavaScript(`document.querySelector('.mini-add input')?.focus()`).catch(() => undefined);
}

let pageBadges = false, shownBadge = -1;
function showBadge(count) {
  const n = clampBadge(count);
  if (n === shownBadge) return;
  shownBadge = n;
  try { app.setBadgeCount(n); } catch { /* Linux without a launcher that shows counts */ }
  if (tray) tray.setToolTip(n > 0 ? `Project Tracker (${n} unread)` : 'Project Tracker');
  if (WIN && win) overlayBadge(n);
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
  // Only web and mail links go to the operating system: file:, smb:, ms-* and other schemes in page content are never handed over.
  if (p.linkURL) items.push(...(/^https?:|^mailto:/i.test(p.linkURL) ? [{ label: 'Open link in browser', click: () => shell.openExternal(p.linkURL) }] : []), { label: 'Copy link address', click: () => require('electron').clipboard.writeText(p.linkURL) }, { type: 'separator' });
  if (p.mediaType === 'image') items.push({ label: 'Copy image', click: () => win.webContents.copyImageAt(p.x, p.y) }, { label: 'Save image as…', click: () => win.webContents.downloadURL(p.srcURL) }, { type: 'separator' });
  if (p.isEditable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  else if (p.selectionText) items.push({ role: 'copy' });
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

let rebuildTray = () => {};
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Project Tracker');
  const build = () => Menu.buildFromTemplate([
    { label: 'Open Project Tracker', click: () => { win.show(); win.focus(); } },
    { label: 'Quick add or ask Aura…', accelerator: 'CommandOrControl+Shift+Space', click: toggleMini },
    { label: 'Search…', click: quickSearch },
    { label: 'My work', click: () => go('/my-work') },
    { label: 'Reminders', click: () => go('/reminders') },
    { type: 'separator' },
    { label: 'Start when I sign in to my computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }); saveSettings({ startHidden: i.checked }); } },
    { label: 'Keep running in the tray when the window is closed', type: 'checkbox', checked: settings().keepRunning, click: (i) => saveSettings({ keepRunning: i.checked }) },
    ...(CAN_SHIELD ? [shieldMenuItem()] : []),
    { type: 'separator' },
    ...(updateReady ? [{ label: `Restart to update to ${updateReady}`, click: installUpdate }] : []),
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(build());
  rebuildTray = () => tray && tray.setContextMenu(build());
  tray.on('click', toggleMini);
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
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { label: 'Actual size', accelerator: 'CommandOrControl+0', click: () => setZoom(DEFAULT_ZOOM) }, { label: 'Zoom in', accelerator: 'CommandOrControl+Plus', click: () => setZoom(settings().zoom + 0.05) }, { label: 'Zoom out', accelerator: 'CommandOrControl+-', click: () => setZoom(settings().zoom - 0.05) }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(CAN_SHIELD ? [{ type: 'separator' }, shieldMenuItem()] : [])] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [...(updateReady ? [{ label: `Restart to update to ${updateReady}`, click: installUpdate }, { type: 'separator' }] : []), { label: 'Open in browser', click: () => shell.openExternal(BASE) }, { label: 'Check for updates', click: () => checkUpdates(true) }, { label: 'Downloads page', click: () => shell.openExternal(DOWNLOAD_PAGE) }, { type: 'separator' }, { label: `Version ${app.getVersion()}`, enabled: false }] },
  ]));
}

// ---- updates
// Windows (installer) and Linux (AppImage): the new version is downloaded quietly in the background and installed the next time the app is closed,
// or at once when the person chooses "Restart to update". The Mac app is not signed with a paid Apple certificate, so macOS cannot replace it
// by itself: there the person is told, and the Downloads page has the new disk image.
const canSelfUpdate = () => app.isPackaged && (WIN || (process.platform === 'linux' && !!process.env.APPIMAGE));
let updateReady = null;   // the version that is downloaded and waiting

function updaterSetup() {
  if (!canSelfUpdate()) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    buildMenu(); rebuildTray();
    const n = new Notification({ title: `Project Tracker ${info.version} is ready`, body: 'It installs when you close the app, or restart now from Help → Restart to update.' });
    n.on('click', () => installUpdate()); n.show();
    if (win && !win.isDestroyed()) win.webContents.send('update-ready', info.version);
  });
  autoUpdater.on('error', () => { /* offline or no release yet: try again later */ });
}
function installUpdate() { quitting = true; autoUpdater.quitAndInstall(false, true); }

/** Looks for a newer version. `manual`: the person asked, so say what was found either way. */
async function checkUpdates(manual) {
  if (canSelfUpdate()) {
    try {
      const r = await autoUpdater.checkForUpdates();
      if (manual && r && !r.downloadPromise) new Notification({ title: 'Project Tracker is up to date', body: `You have version ${app.getVersion()}.` }).show();
      else if (manual) new Notification({ title: 'Downloading the update', body: 'It will install when you close the app.' }).show();
    } catch { if (manual) new Notification({ title: 'Could not check for updates', body: 'Try again when you are online.' }).show(); }
    return;
  }
  try {   // macOS (and running from source): only tell
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
    ipcMain.on('open-connected-accounts', (e, workspaceSlug) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents || !isInternal(e.sender.getURL(), BASE)) return;
      // Send a fixed local account page, never an OAuth code, state or credential. The browser begins its own attempt.
      const slug = typeof workspaceSlug === 'string' && workspaceSlug.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspaceSlug) ? workspaceSlug : null;
      shell.openExternal(new URL(`${slug ? '/' + slug : ''}/account/integrations`, BASE).href);
    });
    ipcMain.on('win-control', (e, action) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents || !isInternal(e.sender.getURL(), BASE)) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
      else if (action === 'close') win.close();
      else if (action === 'query') win.webContents.send('win-maximized', win.isMaximized());
    });
    // The page turns the screen-share shield on while it shows the password vault, and off when it leaves it.
    ipcMain.on('protect-content', (e, on) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents || !isInternal(e.sender.getURL(), BASE)) return;
      pageShield = on === true;
      applyShield();
    });
    // The page asks for attention when an alert arrives and the window is not in front: the taskbar button flashes (Windows, Linux) or the
    // dock icon bounces (Mac) until the person comes back. Urgent alerts (reminders, overdue, security) keep going until then.
    ipcMain.on('badge', (e, count) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents || !isInternal(e.sender.getURL(), BASE)) return;
      pageBadges = true;
      showBadge(count);
    });
    // System notifications for the page. Electron cannot show a service worker's notifications (registration.showNotification does
    // nothing here) and the page's own `new Notification()` loses its click when the window is hidden, so the page hands them to the main
    // process: a native toast / Notification Center entry with the app's name and icon (AppUserModelID on Windows), that opens the link.
    ipcMain.on('notify', (e, n) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents || !isInternal(e.sender.getURL(), BASE) || !n || typeof n !== 'object') return;
      if (!Notification.isSupported()) return;
      const title = String(n.title || 'Project Tracker').slice(0, 120);
      const body = String(n.body || '').slice(0, 300);
      const link = typeof n.link === 'string' && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : '/';
      const tag = typeof n.tag === 'string' ? n.tag.slice(0, 80) : '';
      // One entry per tag: a repeat replaces the earlier toast instead of stacking.
      if (tag && shown.has(tag)) { try { shown.get(tag).close(); } catch { /* already gone */ } }
      // Quick actions (urgent notices only): buttons that work with the window closed, through the notice's one-time key.
      const buttons = tag && settings().quickActions !== false ? quick.buttonsFor(n.qa, n.actions) : [];
      if (buttons.length) { quickKeys.set(tag, { qa: n.qa, link, title, body }); if (quickKeys.size > 200) quickKeys.delete(quickKeys.keys().next().value); }
      const options = { title, body, silent: n.silent === true, urgency: n.urgent ? 'critical' : 'normal', timeoutType: n.urgent ? 'never' : 'default' };
      if (buttons.length && MAC) {
        // macOS: the buttons are in the notice's menu; Reply is the native inline reply field.
        const plain = buttons.filter((a) => a !== 'reply');
        Object.assign(options, { actions: plain.map((a) => ({ type: 'button', text: quick.LABELS[a] })), hasReply: buttons.includes('reply'), replyPlaceholder: 'Reply…' });
        options._plain = plain;
      } else if (buttons.length && WIN) {
        options.toastXml = quick.toastXml({ title, body, tag, buttons, urgent: n.urgent === true });
      }
      const plain = options._plain || []; delete options._plain;
      const note = new Notification(options);
      note.on('action', (_ev, index) => { const a = plain[index]; if (a) void pressQuick(tag, a); });
      note.on('reply', (_ev, reply) => { void pressQuick(tag, 'reply', reply); });
      note.on('click', () => { go(link); if (tag) shown.delete(tag); });
      note.on('close', () => { if (tag && shown.get(tag) === note) shown.delete(tag); });
      if (tag) shown.set(tag, note);
      note.show();
    });
    ipcMain.on('notify-close', (e, tags) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents || !Array.isArray(tags)) return;
      for (const t of tags) { const note = shown.get(String(t)); if (note) { try { note.close(); } catch { /* gone */ } shown.delete(String(t)); } }
    });
    // A new page (signed out, reloaded) starts from the title again until it reports its number.
    ipcMain.on('attention', (e, kind) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents || !isInternal(e.sender.getURL(), BASE) || win.isFocused()) return;
      const urgent = kind === 'urgent';
      if (MAC) app.dock?.bounce(urgent ? 'critical' : 'informational');
      else win.flashFrame(true);
    });
    buildMenu(); createTray(); createWindow();
    // One shortcut anywhere on the computer: the mini window, ready to add a reminder or ask Aura.
    globalShortcut.register('CommandOrControl+Shift+Space', toggleMini);
    ipcMain.on('mini-open', (e, link) => {
      if (!mini || mini.isDestroyed() || e.sender !== mini.webContents || !isInternal(e.sender.getURL(), BASE)) return;
      if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//')) return;
      mini.hide(); if (win) { win.show(); win.focus(); } go(link);
    });
    ipcMain.on('mini-hide', (e) => { if (mini && !mini.isDestroyed() && e.sender === mini.webContents) mini.hide(); });
    ipcMain.on('quick-actions', (e, on) => { if (win && e.sender === win.webContents) saveSettings({ quickActions: on === true }); });
    updaterSetup();
    setTimeout(() => checkUpdates(false), 15000);
    setInterval(() => checkUpdates(false), 4 * 60 * 60 * 1000);   // and every few hours while it stays open
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else win.show(); });
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
}
