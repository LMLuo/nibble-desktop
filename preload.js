'use strict'
// 单一 preload：紧凑层（overlay.js）与展开层（pet.js / scene.js）共用。
//
// - nibbleOverlay：悬浮窗自己的桥（穿透切换 / 展开 / 收起 / 拖动 / ready）
// - acquireVsCodeApi：pet.js 的宿主判定兼容层（`typeof acquireVsCodeApi === 'function'`），
//   下行数据经 window.postMessage 转交，正好命中 pet.js / scene.js 的 message 监听。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nibbleOverlay', {
  platform: process.platform, // 渲染层据此隐藏当前平台不支持的功能（如 Linux 的窗口透明度）
  openPanel: () => ipcRenderer.send('overlay-open-panel'),
  openView: (v) => ipcRenderer.send('overlay-open-view', v), // 直达武器库/怪物库
  collapse: () => ipcRenderer.send('overlay-collapse'), // 展开态收起
  moveBy: (dx, dy) => ipcRenderer.send('overlay-move-by', dx, dy), // 拖动：窗口跟随鼠标位移
  moveEnd: () => ipcRenderer.send('overlay-move-end'), // 拖动结束：保存位置
  opacitySet: (v) => ipcRenderer.send('overlay-opacity-set', v), // 透明度绝对设置（滑条）
  opacityDelta: (d) => ipcRenderer.send('overlay-opacity-delta', d), // 透明度增量（滚轮）
  closeOpacity: () => ipcRenderer.send('overlay-opacity-close'), // 关闭透明度小窗
  openKeyStats: () => ipcRenderer.send('overlay-keystats-open'), // 打开按键统计浮窗
  closeKeyStats: () => ipcRenderer.send('overlay-keystats-close'), // 关闭按键统计浮窗
  mouseDay: (date) => ipcRenderer.send('mousemap-day', date), // 鼠标轨迹：切换某一天
  closeMouseMap: () => ipcRenderer.send('overlay-mousemap-close'), // 关闭鼠标轨迹浮窗
  ready: () => ipcRenderer.send('overlay-ready'),
})

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (msg) => ipcRenderer.send('panel-msg', msg),
  getState: () => ({}),
}))

ipcRenderer.on('push', (_e, msg) => {
  try {
    window.postMessage(msg, '*')
  } catch { /* 忽略 */ }
})
