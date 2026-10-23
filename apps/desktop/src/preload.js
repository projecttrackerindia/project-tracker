'use strict';
// The only things the page can ask of the desktop app: minimize / maximize / close its own window (the app draws its own window buttons),
// to flash the taskbar button / bounce the dock icon when an alert arrives while the window is not in front, and to keep the window out of
// screen sharing and recordings while it shows secrets (the password vault).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ptDesktop', {
  platform: process.platform,
  openConnectedAccounts: (workspaceSlug) => ipcRenderer.send('open-connected-accounts', workspaceSlug),
  protectContent: (on) => { ipcRenderer.send('protect-content', on === true); },
  attention: (kind) => { ipcRenderer.send('attention', kind === 'urgent' ? 'urgent' : 'normal'); },
  windowControl: (action) => { if (action === 'minimize' || action === 'maximize' || action === 'close') ipcRenderer.send('win-control', action); },
  onMaximizeChange: (cb) => { ipcRenderer.on('win-maximized', (_e, maximized) => cb(!!maximized)); ipcRenderer.send('win-control', 'query'); },
});
