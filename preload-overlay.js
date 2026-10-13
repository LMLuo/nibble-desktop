'use strict'
// 悬浮窗的桥：
//   - hover(on)   通知主进程开/关鼠标穿透（悬停热区时接管，可拖动可点击）
//   - openPanel() 点击小生物 → 打开完整面板
//   - 'push'      主进程的游戏状态广播 → window.postMessage 交给 overlay.js

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nibbleOverlay', {
  hover: (on) => ipcRenderer.send('overlay-hover', !!on),
  openPanel: () => ipcRenderer.send('overlay-open-panel'),
  ready: () => ipcRenderer.send('overlay-ready'),
})

ipcRenderer.on('push', (_e, msg) => {
  try {
    window.postMessage(msg, '*')
  } catch { /* 忽略 */ }
})
