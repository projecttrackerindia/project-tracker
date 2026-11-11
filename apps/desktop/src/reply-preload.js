'use strict';
// The Reply / Reject card's only bridge: send the typed words, or cancel. Nothing else reaches the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ptReply', {
  send: (text) => ipcRenderer.send('reply-send', String(text || '').slice(0, 2000)),
  cancel: () => ipcRenderer.send('reply-cancel'),
});
