'use strict';
// The only thing the page can ask the desktop app for: the colors of the window's title bar (so it matches the theme). Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ptDesktop', {
  platform: process.platform,
  setTitleBar: (bg, fg) => { if (typeof bg === 'string' && typeof fg === 'string') ipcRenderer.send('titlebar', { bg, fg }); },
});
