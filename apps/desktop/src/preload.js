'use strict';
// The only things the page can ask of the desktop app: minimize / maximize / close its own window (the app draws its own window buttons),
// to flash the taskbar button / bounce the dock icon when an alert arrives while the window is not in front, and to keep the window out of
// screen sharing and recordings while it shows secrets (the password vault). Also: buttons on native notices (quick actions) and the tray mini window.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ptDesktop', {
  platform: process.platform,
  openConnectedAccounts: (workspaceSlug) => ipcRenderer.send('open-connected-accounts', workspaceSlug),
  protectContent: (on) => { ipcRenderer.send('protect-content', on === true); },
  setBadge: (count) => { ipcRenderer.send('badge', Number(count) || 0); },
  notify: (n) => { if (n && typeof n === 'object') ipcRenderer.send('notify', { title: String(n.title || ''), body: String(n.body || ''), link: String(n.link || '/'), tag: String(n.tag || ''), silent: n.silent === true, urgent: n.urgent === true,
    qa: typeof n.qa === 'string' ? n.qa.slice(0, 400) : undefined, actions: Array.isArray(n.actions) ? n.actions.map(String).slice(0, 6) : undefined }); },
  // Quick actions: buttons on native notices on or off (Settings › Notifications), and the mini window's links into the main window.
  setQuickActions: (on) => { ipcRenderer.send('quick-actions', on === true); },
  openMain: (link) => { ipcRenderer.send('mini-open', String(link || '/')); },
  hideMini: () => { ipcRenderer.send('mini-hide'); },
  closeNotifications: (tags) => { if (Array.isArray(tags)) ipcRenderer.send('notify-close', tags.map(String).slice(0, 100)); },
  attention: (kind) => { ipcRenderer.send('attention', kind === 'urgent' ? 'urgent' : 'normal'); },
  windowControl: (action) => { if (action === 'minimize' || action === 'maximize' || action === 'close') ipcRenderer.send('win-control', action); },
  onMaximizeChange: (cb) => { ipcRenderer.on('win-maximized', (_e, maximized) => cb(!!maximized)); ipcRenderer.send('win-control', 'query'); },
});
