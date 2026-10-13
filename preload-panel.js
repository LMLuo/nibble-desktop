'use strict'
// 面板窗口的宿主 shim：让 media/pet.js / scene.js 零改动跑在 Electron 里。
//
// pet.js 的宿主判定是 `typeof acquireVsCodeApi === 'function'`，
// 这里用 contextBridge 暴露同名 API；下行数据经 window.postMessage 转交，
// 正好命中 pet.js / scene.js 里 `window.addEventListener('message', ...)` 的监听。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (msg) => ipcRenderer.send('panel-msg', msg),
  getState: () => ({}),
}))

ipcRenderer.on('push', (_e, msg) => {
  try {
    window.postMessage(msg, '*')
  } catch { /* 忽略 */ }
})
