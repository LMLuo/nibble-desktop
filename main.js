'use strict'
// nibble-desktop —— nibble 的 Windows 桌面伴生版（Electron）
//
// 分工：
//   - 主进程持有游戏核心 lib/nibble.js（本进程是存档唯一写手）：
//     全局键盘监听（空格 / 回车 = 攻击，只观察不拦截）→ attack → 落盘 → 定时广播状态
//   - 悬浮窗 overlay/：透明、置顶、鼠标穿透的桌面小生物；悬停热区可拖动，点击打开面板
//   - 面板窗口 media/panel.html（+ pet.js / scene.js）：完整战斗场景 / 武器库 / 怪物库
//
// 独立存档：游戏核心用 CODEBUDDY_PLUGIN_DATA 环境变量定位数据目录，
// 这里把它指向本应用自己的 userData —— 与 IDE 扩展互不读写。
// ⚠️ 必须先设置环境变量、再 require 游戏核心（lib 顶层就会用到它）。

const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')

// ============================ 存档隔离（顺序关键） ============================
const SAVE_DIR = path.join(app.getPath('userData'), 'save')
process.env.CODEBUDDY_PLUGIN_DATA = SAVE_DIR
const sp = require('./lib/nibble')

// 键盘攻击的最小间隔：空格 / 回车是最高频按键，不节流会把怪秒掉
const MIN_ATTACK_INTERVAL_MS = 3000

let overlayWin = null
let panelWin = null
let tray = null
let paused = false // 托盘「暂停键盘攻击」（只停键盘通道，面板按钮不受影响）
let quitting = false

// ============================ 全局键盘监听 ============================
let hook = null
let attackKeys = null
const pressed = new Set() // 判定「长按自动重复」：按住不放只算一次按压
let lastKeyAttackAt = 0

function startHook() {
  try {
    const uio = require('uiohook-napi')
    hook = uio.uIOhook
    attackKeys = new Set([uio.UiohookKey.Space, uio.UiohookKey.Enter])
    hook.on('keydown', (e) => {
      if (!attackKeys.has(e.keycode)) return
      if (pressed.has(e.keycode)) return
      pressed.add(e.keycode)
      keyboardAttack()
    })
    hook.on('keyup', (e) => pressed.delete(e.keycode))
    hook.start()
  } catch (err) {
    // 原生监听不可用时游戏照常：面板「攻击一次」按钮仍可用
    console.error('[nibble] 全局键盘监听不可用：', err && err.message)
  }
}

function keyboardAttack() {
  if (paused) return
  const now = Date.now()
  if (now - lastKeyAttackAt < MIN_ATTACK_INTERVAL_MS) return
  lastKeyAttackAt = now
  doAttack()
}

function doAttack() {
  try {
    const s = sp.loadSave()
    sp.attack(s)
    sp.saveSave()
    tick() // 立即广播，攻击反馈不拖到下一个节拍
  } catch { /* 存档异常时静默，不影响其他程序 */ }
}

// ============================ 状态构建与广播 ============================
// 移植自 IDE 扩展的 tick（extension.js），差异只有两点：
//   1) 单进程单写手 → 用 loadSave()（内存缓存）而非 reloadSave()（防多进程写档）
//   2) targets = [悬浮窗, 面板窗口]，同一个 'push' 频道广播
let frame = 0
let lungeTicks = 0
let dissolveTicks = 0
let lastBattles = -1
let lastDefeats = -1
let lastStreakTier = -1
let lastKey = ''
let lastDropAt = -1
let lastArsenalDefeats = -1
let lastBestiaryKey = ''

const flat = (grid) => {
  const out = []
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid.length; c++) out.push(grid[r][c] || '')
  }
  return out
}

function buildState() {
  const s = sp.loadSave()
  const arsenal = sp.arsenalSummary(s)
  const sk = sp.streakState(s)
  const shown = sp.equippedWeapon(s)
  const weaponSprite = shown ? sp.weaponSpriteGrid(shown.id, true) : null
  const info = sp.enemyInfo(s.enemy.type)
  return {
    player: flat(sp.decodeGrid('player').grid),
    enemy: flat(sp.enemyGrid(s.enemy.type, s.enemy.rarity, false)),
    level: s.level,
    exp: s.exp,
    xpNeed: sp.xpNeed(s.level),
    hp: s.enemy.hp,
    maxHp: s.enemy.maxHp,
    enemyType: s.enemy.type,
    enemyName: info.name,
    enemyTier: info.tier,
    enemyTierLabel: info.tierLabel,
    enemyMech: info.mechText,
    bestiary: sp.bestiarySummary(s),
    rarityLabel: sp.RARITY_LABEL[s.enemy.rarity],
    rarity: s.enemy.rarity,
    rarityColor: sp.RARITY_COLOR[s.enemy.rarity],
    battles: s.battles,
    defeats: s.defeats,
    log: s.lastLog || 'Nibble 待命中…（敲空格 / 回车即可发动攻击）',
    streak: sk.count,
    streakTier: sk.tier,
    streakBonus: sk.bonus,
    lastDmg: Math.max(0, Number(s.lastDmg) || 0),
    key: s.enemy.type + '|' + s.enemy.rarity + '|' + s.enemy.maxHp + '|' + s.battles +
      '|' + (s.equipped || '') + '|' + (shown ? shown.id : '') + '|' + sk.count,
    arsenal,
    weaponSprite: weaponSprite ? flat(weaponSprite) : null,
    weaponName: shown ? shown.name : null,
    weaponRarity: shown ? shown.rarity : null,
    weaponPower: shown ? shown.power : 0,
    weaponColor: shown ? sp.RARITY_COLOR[shown.rarity] : null,
  }
}

function buildArsenalData(arsenal) {
  const sprites = {}
  for (const w of sp.WEAPONS) {
    const g = sp.weaponSpriteGrid(w.id, 'box')
    sprites[w.id] = g ? flat(g) : null
  }
  return {
    type: 'arsenalData',
    owned: arsenal.ownedMap,
    pity: arsenal.pity,
    pityLimit: arsenal.pityLimit,
    equipped: arsenal.equipped,
    shown: arsenal.shown,
    atkBase: arsenal.atkBase,
    atkTotal: arsenal.atkTotal,
    list: sp.WEAPONS,
    sprites,
  }
}

function buildBestiaryData(sum, currentId) {
  const sprites = {}
  for (const e of sp.ENEMIES) sprites[e.id] = flat(sp.enemyGrid(e.id, 'common', false))
  return {
    type: 'bestiaryData',
    seen: sum.seenMap,
    defeated: sum.defeatedMap,
    current: currentId || null,
    list: sp.ENEMIES.map((e) => ({
      id: e.id,
      name: e.name,
      tier: e.tier,
      minLv: e.minLv,
      story: e.story || '',
      mechText: sp.mechSummary(e),
    })),
    sprites,
  }
}

function broadcast(msg) {
  for (const w of [overlayWin, panelWin]) {
    try {
      if (w && !w.isDestroyed()) w.webContents.send('push', msg)
    } catch { /* 窗口可能正在销毁 */ }
  }
}

function tick() {
  let st
  try {
    st = buildState()
  } catch {
    return
  }
  frame = (frame + 1) % 2

  // 攻击 → 前冲；击败 → 敌方消散闪烁
  if (lastBattles !== -1 && st.battles > lastBattles) lungeTicks = 3
  if (lastDefeats !== -1 && st.defeats > lastDefeats) dissolveTicks = 6
  lastBattles = st.battles
  lastDefeats = st.defeats
  if (lungeTicks > 0) lungeTicks--
  if (dissolveTicks > 0) dissolveTicks--
  // 超载演出：连击档位「跨入 ≥50」的那一次
  const burst = lastStreakTier >= 0 && lastStreakTier < 3 && st.streakTier >= 3
  lastStreakTier = st.streakTier

  if (st.key !== lastKey) {
    lastKey = st.key
    broadcast(Object.assign({ type: 'state' }, st))
  }
  if (burst) broadcast({ type: 'burst', combo: st.streak })
  const lastDrop = st.arsenal.last
  if (lastDrop && lastDrop.at && lastDrop.at !== lastDropAt) {
    lastDropAt = lastDrop.at
    broadcast({
      type: 'drop',
      name: lastDrop.name,
      rarity: lastDrop.rarity,
      color: sp.RARITY_COLOR[lastDrop.rarity],
      rarityLabel: sp.RARITY_LABEL[lastDrop.rarity],
      story: lastDrop.story,
      sprite: st.weaponSprite,
    })
  }
  if (lastArsenalDefeats !== st.defeats) {
    lastArsenalDefeats = st.defeats
    broadcast(buildArsenalData(st.arsenal))
  }
  const bestiaryKey = st.bestiary.seen + '|' + st.bestiary.totalDefeats
  if (bestiaryKey !== lastBestiaryKey) {
    lastBestiaryKey = bestiaryKey
    broadcast(buildBestiaryData(st.bestiary, st.enemyType))
  }
  broadcast({
    type: 'tick',
    frame,
    lunge: lungeTicks > 0,
    blink: (st.rarity === 'rare' || st.rarity === 'legendary') && frame === 0,
    dissolve: dissolveTicks > 0,
    hp: st.hp,
    maxHp: st.maxHp,
    level: st.level,
    log: st.log,
  })
}

// ============================ 悬浮窗（桌面小生物） ============================
const OVERLAY_W = 264
const OVERLAY_H = 176

function posFile() {
  return path.join(app.getPath('userData'), 'overlay-pos.json')
}

function readOverlayPos() {
  try {
    const p = JSON.parse(fs.readFileSync(posFile(), 'utf8'))
    const wa = screen.getPrimaryDisplay().workArea
    if (Number.isFinite(p.x) && Number.isFinite(p.y) &&
      p.x >= wa.x - OVERLAY_W / 2 && p.y >= wa.y - 10 &&
      p.x < wa.x + wa.width - 20 && p.y < wa.y + wa.height - 20) {
      return { x: Math.round(p.x), y: Math.round(p.y) }
    }
  } catch { /* 没有记录 / 损坏 → 默认位置 */ }
  return null
}

function defaultOverlayBounds() {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - OVERLAY_W - 24, y: wa.y + wa.height - OVERLAY_H - 40 }
}

function saveOverlayPos() {
  try {
    if (!overlayWin || overlayWin.isDestroyed()) return
    const b = overlayWin.getBounds()
    fs.writeFileSync(posFile(), JSON.stringify({ x: b.x, y: b.y }), 'utf8')
  } catch { /* 保存失败不影响退出 */ }
}

function createOverlay() {
  const pos = readOverlayPos() || defaultOverlayBounds()
  overlayWin = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver') // 压过普通置顶窗口
  overlayWin.setIgnoreMouseEvents(true, { forward: true }) // 默认穿透，悬停热区时才接管
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'index.html'))
  overlayWin.on('close', saveOverlayPos)
  overlayWin.on('closed', () => { overlayWin = null })
}

// ============================ 面板窗口 ============================
function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show()
    panelWin.focus()
    return
  }
  panelWin = new BrowserWindow({
    width: 900,
    height: 660,
    title: 'Nibble · 像素小生物',
    backgroundColor: '#171210',
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  panelWin.loadFile(path.join(__dirname, 'media', 'panel.html'))
  panelWin.on('closed', () => { panelWin = null })
}

// ============================ 托盘 ============================
const exeForLogin = () => process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe')

function getAutoLaunch() {
  try {
    return app.getLoginItemSettings({ path: exeForLogin() }).openAtLogin
  } catch {
    return false
  }
}

function setAutoLaunch(on) {
  try {
    // 便携 exe 的 app.getPath('exe') 指向运行时临时解压目录，
    // 必须用 PORTABLE_EXECUTABLE_FILE（真实 exe 路径）注册自启，否则重启后失效
    app.setLoginItemSettings({ openAtLogin: !!on, path: exeForLogin() })
  } catch { /* 忽略 */ }
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开面板', click: openPanel },
    { type: 'separator' },
    {
      label: '暂停键盘攻击（空格 / 回车）',
      type: 'checkbox',
      checked: paused,
      click: (item) => {
        paused = item.checked
        tray.setContextMenu(trayMenu())
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: getAutoLaunch(),
      click: (item) => {
        setAutoLaunch(item.checked)
        tray.setContextMenu(trayMenu())
      },
    },
    { type: 'separator' },
    {
      label: '退出 Nibble',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.png'))
    tray.setToolTip('Nibble · 敲空格 / 回车发起攻击')
    tray.setContextMenu(trayMenu())
    tray.on('double-click', openPanel)
  } catch (err) {
    console.error('[nibble] 托盘创建失败：', err && err.message)
  }
}

// ============================ 渲染层消息 ============================
// 面板（pet.js 通过 acquireVsCodeApi shim 发来）
ipcMain.on('panel-msg', (_e, msg) => {
  if (!msg) return
  if (msg.type === 'ready') {
    // 重开面板也要拿到全量数据：清掉所有「变化检测」缓存
    lastKey = ''
    lastArsenalDefeats = -1
    lastBestiaryKey = ''
    tick()
  } else if (msg.type === 'attack') {
    doAttack()
  } else if (msg.type === 'reset') {
    try {
      sp.reset()
      lastKey = ''
      lastArsenalDefeats = -1
      lastBestiaryKey = ''
      lastStreakTier = -1
      lastBattles = -1
      lastDefeats = -1
      lastDropAt = -1
      tick()
    } catch { /* 忽略 */ }
  } else if (msg.type === 'equip') {
    try {
      sp.equipWeapon(msg.id || null)
      lastKey = ''
      lastArsenalDefeats = -1
      tick()
    } catch { /* 存档读写失败时静默忽略 */ }
  }
  // 'expand' 无意义（面板本来就是独立窗口），忽略
})

// 悬浮窗：悬停热区 → 关闭穿透（可点击/拖动），离开 → 恢复穿透
ipcMain.on('overlay-hover', (_e, hovering) => {
  try {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(!hovering, { forward: true })
    }
  } catch { /* 忽略 */ }
})
ipcMain.on('overlay-open-panel', openPanel)
ipcMain.on('overlay-ready', () => {
  lastKey = ''
  tick()
})

// ============================ 生命周期 ============================
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.show()
    openPanel()
  })

  app.whenReady().then(() => {
    createOverlay()
    createTray()
    startHook()
    setInterval(tick, 400)
    tick()
  })

  // 托盘常驻应用：窗口全关也不退出
  app.on('window-all-closed', () => { /* no-op */ })

  app.on('before-quit', () => {
    quitting = true
    try {
      if (hook) hook.stop()
    } catch { /* 忽略 */ }
  })

  // macOS 惯例（桌面版以 Windows 为主，保留兜底）
  app.on('activate', () => {
    if (app.isReady() && !overlayWin) createOverlay()
  })
}
