'use strict';
// The only things the page can ask of the desktop app: minimize / maximize / close its own window (the app draws its own window buttons).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ptDesktop', {
  platform: process.platform,
  windowControl: (action) => { if (action === 'minimize' || action === 'maximize' || action === 'close') ipcRenderer.send('win-control', action); },
  onMaximizeChange: (cb) => { ipcRenderer.on('win-maximized', (_e, maximized) => cb(!!maximized)); ipcRenderer.send('win-control', 'query'); },
});
