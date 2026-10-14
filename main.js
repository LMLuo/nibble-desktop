'use strict'
// nibble-desktop —— nibble 的 Windows 桌面伴生版（Electron）
//
// 分工：
//   - 主进程持有游戏核心 lib/nibble.js（本进程是存档唯一写手）：
//     全局键盘监听（空格 / 回车 = 攻击，只观察不拦截）→ attack → 落盘 → 定时广播状态
//   - 悬浮窗（唯一窗口，双形态）：
//     紧凑态 = 透明置顶穿透的迷你战斗舞台；展开态 = 原地放大为完整 UI（战斗/武器库/怪物库）
//     （v0.3 起：独立面板窗口已删除，功能全部收进悬浮窗）
//
// 独立存档：游戏核心用 CODEBUDDY_PLUGIN_DATA 环境变量定位数据目录，
// 这里把它指向本应用自己的 userData —— 与 IDE 扩展互不读写。
// ⚠️ 必须先设置环境变量、再 require 游戏核心（lib 顶层就会用到它）。

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// ============================ 平台差异（Linux 移植） ============================
// 本应用以 Windows 为主、Linux 为次；差异全部收敛在下面几个常量里，别在别处再判断 platform：
//   - setOpacity：Electron 官方口径「On Linux, does nothing」→ 透明度功能整体隐藏。
//     宁可让用户看不到这个菜单，也不要给一根拖了没反应的假滑条。
//   - setLoginItemSettings：仅 macOS / Windows 实现 → Linux 隐藏「开机自启」。
//   - 全局键盘监听：uiohook 走 X11 的 XRecord，Wayland 会话下（含 XWayland）收不到任何按键
//     → 启动时明确提示切 X11 会话，否则「敲键盘没反应」会被当成程序坏了。
const IS_LINUX = process.platform === 'linux'
const SUPPORTS_OPACITY = !IS_LINUX
const SUPPORTS_AUTOLAUNCH = !IS_LINUX
const WAYLAND = IS_LINUX && (process.env.XDG_SESSION_TYPE === 'wayland' ||
  (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'x11'))

// ⚠️ 本机 GPU 环境与 Electron 合成层的兼容性结论（全部实测）：
//   - transparent 窗口：resize 白屏 / 禁 GPU 后整个不显示 → 已弃用 transparent（v0.4.0）
//   - 普通窗口 + GPU：页面帧不提交（只有背景色，全黑）→ GPU 进程崩溃无回退
//   - 普通窗口 + 软件渲染 = 唯一稳态：像素 UI 无 GPU 依赖，禁用硬件加速零损失
app.disableHardwareAcceleration()

// 诊断开关：NIBBLE_DIAG=1 时启动 6 秒后截屏存盘并退出（NIBBLE_DIAG_OUT 指定输出路径），
// NIBBLE_DIAG_EXPAND=arsenal|bestiary 时 3 秒先展开一次。
// 日志写文件（GUI 子系统的 stdout 在管道下不可靠）：与截图同目录的 .log
let diagOut = process.env.NIBBLE_DIAG_OUT || ''
let diagOn = !!process.env.NIBBLE_DIAG
const diagLogPath = () => (diagOut ? diagOut + '.log' : path.join(app.getPath('temp'), 'nibble-diag.log'))
function diagLog(msg) {
  try {
    fs.appendFileSync(diagLogPath(), new Date().toISOString() + ' ' + msg + '\n')
  } catch { /* 忽略 */ }
}

// ============================ 存档隔离（顺序关键） ============================
const SAVE_DIR = path.join(app.getPath('userData'), 'save')
process.env.CODEBUDDY_PLUGIN_DATA = SAVE_DIR
const sp = require('./lib/nibble')

// ============================ 本机配置（userData/config.json） ============================
// 攻击间隔四档 + 悬浮窗显隐。没有「设置窗口」，全部通过托盘菜单调整。
const INTERVAL_CHOICES = [
  { ms: 0, label: '无限制（默认）' },
  { ms: 3000, label: '3 秒' },
  { ms: 5000, label: '5 秒' },
  { ms: 10000, label: '10 秒' },
  { ms: 15000, label: '15 秒' },
]
const config = { minAttackIntervalMs: 0, showOverlay: true, overlayOpacity: 1, alwaysOnTop: true }
const configPath = () => path.join(app.getPath('userData'), 'config.json')
const isFirstRun = () => !fs.existsSync(configPath())

function loadConfig() {
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath(), 'utf8')))
    if (!INTERVAL_CHOICES.some((c) => c.ms === config.minAttackIntervalMs)) config.minAttackIntervalMs = 0
    const op = Number(config.overlayOpacity)
    config.overlayOpacity = Number.isFinite(op) ? Math.min(1, Math.max(0.01, op)) : 1
  } catch { /* 首次启动 / 文件损坏 → 默认值 */ }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
  } catch { /* 保存失败不致命 */ }
}

let overlayWin = null
let tray = null
let paused = false // 托盘「暂停键盘攻击」（只停键盘通道，手动攻击不受影响）
let quitting = false

// ============================ 按键统计（悬浮日志） ============================
// 记录每天敲了多少空格 / 回车（userData/keystats.json）；
// 内存计数 + 30s 防抖落盘 + 退出落盘；滚动保留 7 天。
// 口径：长按自动重复不算敲击；托盘「暂停键盘攻击」期间不计数（整块键盘响应关闭）。
const KEYSTAT_KEEP_DAYS = 7
const keyStats = { days: {} } // { 'YYYY-MM-DD': { space, enter } }
let keyStatsDirty = false
const keyStatsPath = () => path.join(app.getPath('userData'), 'keystats.json')

function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function pruneKeyStats() {
  const keys = Object.keys(keyStats.days).sort().reverse()
  for (let i = KEYSTAT_KEEP_DAYS; i < keys.length; i++) delete keyStats.days[keys[i]]
}

function loadKeyStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(keyStatsPath(), 'utf8'))
    if (parsed && parsed.days && typeof parsed.days === 'object') keyStats.days = parsed.days
  } catch { /* 首次 / 损坏 → 空 */ }
  pruneKeyStats()
}

function saveKeyStatsIfDirty() {
  if (!keyStatsDirty) return
  keyStatsDirty = false
  try {
    pruneKeyStats()
    fs.writeFileSync(keyStatsPath(), JSON.stringify(keyStats, null, 2), 'utf8')
  } catch { /* 忽略 */ }
}

function bumpKeyStat(kind) {
  const day = todayKey()
  const rec = keyStats.days[day] || (keyStats.days[day] = { space: 0, enter: 0 })
  rec[kind] = (Number(rec[kind]) || 0) + 1
  keyStatsDirty = true
  broadcast({ type: 'keystats', today: { date: day, space: rec.space, enter: rec.enter } })
}

// 近 7 天明细（新→旧），供统计浮窗使用
function keyStatsAll() {
  const days = Object.keys(keyStats.days).sort().reverse()
    .map((d) => ({ date: d, space: Number(keyStats.days[d].space) || 0, enter: Number(keyStats.days[d].enter) || 0 }))
  const today = days.find((d) => d.date === todayKey())
  return { type: 'keystats-all', days, today: today || { date: todayKey(), space: 0, enter: 0 } }
}

// ============================ 鼠标轨迹（一天的移动热力 + 点击位置） ============================
// 采集：移动每 250ms 采样一点（8px 量化，用于连线）；点击全量记录；
// 热力格 16px 累加计数（移动与点击都计入）。只统计主显示器，滚动保留 7 天。
// 存储：userData/mousetrack.json（防抖 30s + 退出落盘），只存本机、零联网。
const MOUSE_SAMPLE_MS = 250
const mouseDays = { days: {} }
let mouseDirty = false
let mouseLastAt = 0
const mouseTrackPath = () => path.join(app.getPath('userData'), 'mousetrack.json')

function pruneMouseDays() {
  const keys = Object.keys(mouseDays.days).sort().reverse()
  for (let i = KEYSTAT_KEEP_DAYS; i < keys.length; i++) delete mouseDays.days[keys[i]]
}

function loadMouseTrack() {
  try {
    const parsed = JSON.parse(fs.readFileSync(mouseTrackPath(), 'utf8'))
    if (parsed && parsed.days && typeof parsed.days === 'object') mouseDays.days = parsed.days
  } catch { /* 首次 / 损坏 → 空 */ }
  pruneMouseDays()
}

function saveMouseTrackIfDirty() {
  if (!mouseDirty) return
  mouseDirty = false
  try {
    pruneMouseDays()
    fs.writeFileSync(mouseTrackPath(), JSON.stringify(mouseDays), 'utf8')
  } catch { /* 忽略 */ }
}

function recordMouse(x, y, isClick) {
  try {
    const day = todayKey()
    const rec = mouseDays.days[day] || (mouseDays.days[day] = { w: 0, h: 0, cells: {}, path: [], clicks: [] })
    if (!rec.w) {
      const b = screen.getPrimaryDisplay().bounds
      rec.w = b.width
      rec.h = b.height
    }
    const gk = Math.floor(x / 16) + ',' + Math.floor(y / 16)
    rec.cells[gk] = (Number(rec.cells[gk]) || 0) + 1
    if (isClick) rec.clicks.push([Math.round(x), Math.round(y)])
    else rec.path.push([Math.floor(x / 8), Math.floor(y / 8)])
    mouseDirty = true
  } catch { /* 忽略 */ }
}

// 某天的可视化数据（浮窗渲染用）；热力键 "gx,gy"，路径为 8px 量化点，点击为原始坐标
function mouseMapForDay(date) {
  const rec = mouseDays.days[date]
  if (!rec) return { type: 'mousemap', date, empty: true, screen: { w: 1920, h: 1080 }, cells: {}, path: [], clicks: [] }
  return {
    type: 'mousemap',
    date,
    screen: { w: Number(rec.w) || 1920, h: Number(rec.h) || 1080 },
    cells: rec.cells || {},
    path: rec.path || [],
    clicks: rec.clicks || [],
  }
}

const mouseMapDays = () => Object.keys(mouseDays.days).sort().reverse()

// ============================ 全局键盘监听 ============================
let hook = null
let attackKeys = null
let hookErr = '' // 监听失败原因：Linux 上多为 Wayland 会话或缺 libXtst / libX11
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
      if (paused) return // 暂停 = 整块键盘响应关闭（攻击 + 统计都不算）
      bumpKeyStat(e.keycode === uio.UiohookKey.Space ? 'space' : 'enter')
      keyboardAttack()
    })
    hook.on('keyup', (e) => pressed.delete(e.keycode))
    // 鼠标轨迹采集：移动 250ms 采样（高频事件里只做时间差判断，零负担）；点击全量
    hook.on('mousemove', (e) => {
      if (paused) return
      const now = Date.now()
      if (now - mouseLastAt < MOUSE_SAMPLE_MS) return
      mouseLastAt = now
      recordMouse(e.x, e.y, false)
    })
    hook.on('click', (e) => {
      if (paused) return
      recordMouse(e.x, e.y, true)
    })
    hook.start()
    // Wayland 下 uiohook 能「启动成功」却永远收不到事件（XRecord 看不到原生 Wayland 应用），
    // 必须主动标记，否则用户只会觉得「程序坏了，敲了没反应」
    hookErr = WAYLAND ? '当前是 Wayland 会话：X11 的 XRecord 收不到原生 Wayland 应用的按键' : ''
  } catch (err) {
    // 原生监听不可用时游戏照常：面板「攻击一次」按钮仍可用
    hookErr = (err && err.message) || String(err)
    console.error('[nibble] 全局键盘监听不可用：', hookErr)
  }
}

// 监听不可用时的「为什么敲键盘没反应」说明（托盘入口 + 首启提示共用同一段文案）
function hookTroubleDetail() {
  const head = IS_LINUX
    ? 'Nibble 在 Linux 上通过 X11 的 XRecord 扩展读取全局按键，以下情况会导致收不到按键：\n\n' +
      (WAYLAND ? '1. 当前登录的是 Wayland 会话（本次启动已检测到）——\n   请在登录界面右下角齿轮里选择「X11 / Xorg 会话」重新登录。\n' : '') +
      '2. 系统缺少 X11 运行库（libX11 / libXtst / libXinerama）——\n   请安装后重启 Nibble。\n'
    : '可能被杀毒 / 安全软件拦截了键盘钩子。\n'
  return head + '\n技术细节：' + (hookErr || '(无错误信息，但钩子未生效)') +
    '\n\n提示：即便监听不可用，托盘菜单「直达 → 攻击一次」与面板里的攻击按钮仍然可用。'
}

// Wayland 会话：首启弹窗说明一次（之后长期靠托盘那条入口），并在悬浮日志留一行短提示
function warnWaylandOnce() {
  if (!WAYLAND) return
  try {
    const s = sp.loadSave()
    s.lastLog = '⚠️ Wayland 会话：请改用 X11 登录'
    s.logKind = 'idle'
    sp.saveSave()
  } catch { /* 忽略 */ }
  if (config.waylandWarned) return
  config.waylandWarned = true
  saveConfig()
  dialog.showMessageBox({
    type: 'warning',
    title: 'Nibble 需要 X11 会话',
    message: '当前是 Wayland 桌面会话，Nibble 收不到全局按键',
    detail:
      'Nibble 通过 X11 的 XRecord 扩展读取键盘（只看空格 / 回车，不记录其他按键），' +
      '而 Wayland 出于安全设计不允许任何程序监听全局按键。\n\n' +
      '解决办法：注销 → 在登录界面右下角的会话菜单里选择「X11」或「Ubuntu on Xorg」→ 重新登录。\n' +
      '（只需设置一次，之后 Nibble 就能正常工作）\n\n' +
      '在切换之前，托盘菜单「直达 → 攻击一次」和面板里的攻击按钮仍然可用。',
    buttons: ['知道了'],
  })
}

function keyboardAttack() {
  if (paused) return
  const min = config.minAttackIntervalMs
  if (min > 0) {
    const now = Date.now()
    if (now - lastKeyAttackAt < min) return
    lastKeyAttackAt = now
  }
  doAttack() // 无限制档 = 每次敲击都攻击；长按去重始终保留（按住不算敲击）
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
//   2) targets = 悬浮窗（唯一窗口，紧凑/展开共用一个 webContents）
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
  // 悬浮窗（战斗舞台）与弹出层（武器库/怪物库）共用同一条消息流
  for (const w of [overlayWin, viewWin]) {
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
const OVERLAY_W = 300
const OVERLAY_H = 200

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
    // v0.4.0：放弃 transparent（该机型上透明窗 resize 白屏/整个不显示，两次踩坑）
    // 悬浮感改由窗口级 setOpacity（托盘/滑条/滚轮）承担；底色同页面卡片色防闪白
    transparent: false,
    backgroundColor: '#171210',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver') // 压过普通置顶窗口
  // v0.3.1：紧凑态整窗可交互（任意位置可拖 / 原地点击生物展开），不再做部分穿透
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'index.html'))
  overlayWin.on('close', saveOverlayPos)
  overlayWin.on('closed', () => { overlayWin = null })
  // 兜底自愈：渲染进程若因任何原因崩溃（白屏无画面），自动重载页面
  overlayWin.webContents.on('render-process-gone', (event, details) => {
    if (diagOn) diagLog('renderer gone: ' + details.reason)
    try {
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.reload()
    } catch { /* 忽略 */ }
  })
  if (diagOn) {
    overlayWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      diagLog('page L' + level + ': ' + message + ' (' + (sourceId || '?') + ':' + line + ')')
    })
    overlayWin.webContents.on('did-finish-load', () => diagLog('did-finish-load'))
    overlayWin.webContents.on('did-fail-load', (_e, code, desc) => diagLog('did-fail-load ' + code + ' ' + desc))
  }
}

// ============================ 弹出层窗口（武器库 / 怪物库） ============================
// 悬浮窗（战斗舞台）恒定不变；点武器库/怪物库 → 在悬浮窗上方弹出独立浮层
// （无边框、正常比例 900×660 = 面板原生布局），标题栏「─」关闭回舞台
const VIEW_W = 900
const VIEW_H = 660
let viewWin = null

function openPanelView(view) {
  try {
    if (viewWin && !viewWin.isDestroyed()) {
      // 已开着：直接切 tab 并前置
      if (view) viewWin.webContents.send('push', { type: 'view', view })
      viewWin.show()
      viewWin.focus()
      return
    }
    const wa = screen.getPrimaryDisplay().workArea
    const b = overlayWin && !overlayWin.isDestroyed() ? overlayWin.getBounds() : defaultOverlayBounds()
    let x = b.x + b.width - VIEW_W // 与悬浮窗右缘对齐
    let y = b.y - VIEW_H - 8 // 悬浮窗正上方
    if (y < wa.y) y = b.y + b.height + 8 // 上方放不下 → 放下方
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - VIEW_W)
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - VIEW_H)
    viewWin = new BrowserWindow({
      width: VIEW_W,
      height: VIEW_H,
      x,
      y,
      frame: false,
      backgroundColor: '#171210',
      resizable: true,
      alwaysOnTop: config.alwaysOnTop !== false,
      skipTaskbar: true,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    viewWin.setAlwaysOnTop(config.alwaysOnTop !== false, 'screen-saver')
    viewWin.loadFile(path.join(__dirname, 'overlay', 'index.html'), { hash: 'full' })
    viewWin.webContents.on('did-finish-load', () => {
      try {
        viewWin.webContents.send('push', { type: 'mode', full: true, opacity: Number(config.overlayOpacity) || 1 })
        if (view) viewWin.webContents.send('push', { type: 'view', view })
      } catch { /* 忽略 */ }
    })
    viewWin.on('closed', () => { viewWin = null })
  } catch { /* 忽略 */ }
}

function closeView() {
  try {
    if (viewWin && !viewWin.isDestroyed()) viewWin.close()
  } catch { /* 忽略 */ }
}

// 悬浮窗显隐 / 透明度 / 置顶：托盘控制，状态跟随配置（重启后保持）
function applyOverlayVisibility() {
  try {
    if (!overlayWin || overlayWin.isDestroyed()) return
    if (config.showOverlay) overlayWin.show()
    else overlayWin.hide()
    overlayWin.setOpacity(Number(config.overlayOpacity) || 1)
    // 置顶用 'screen-saver' 层级：高于普通置顶窗口，压过大多数「总在最前」的应用
    overlayWin.setAlwaysOnTop(config.alwaysOnTop !== false, 'screen-saver')
  } catch { /* 忽略 */ }
}

let opacitySaveTimer = null
function setOverlayOpacity(v) {
  // Linux：setOpacity 是空操作（Electron 未实现），滚轮/滑条一律忽略且不落盘，
  // 免得配置里存着一个永远不生效的值，换回 Windows 时突然变半透明
  if (!SUPPORTS_OPACITY) return
  try {
    config.overlayOpacity = Math.min(1, Math.max(0.01, Number(v) || 1)) // 1%~100% 自定义
    applyOverlayVisibility()
    // 连续调节（滑条/滚轮）：防抖落盘
    if (opacitySaveTimer) clearTimeout(opacitySaveTimer)
    opacitySaveTimer = setTimeout(saveConfig, 400)
    if (tray) tray.setContextMenu(trayMenu()) // 刷新托盘勾选
    if (opacityWin && !opacityWin.isDestroyed()) {
      // 小滑条窗同步数值（拖动自身时回填无副作用）
      opacityWin.webContents.send('push', { type: 'opacity-init', v: config.overlayOpacity })
    }
  } catch { /* 忽略 */ }
}
ipcMain.on('overlay-opacity-set', (_e, v) => setOverlayOpacity(v))
ipcMain.on('overlay-opacity-delta', (_e, d) => setOverlayOpacity((Number(config.overlayOpacity) || 1) + (Number(d) || 0)))
ipcMain.on('overlay-opacity-close', () => {
  try {
    if (opacityWin && !opacityWin.isDestroyed()) opacityWin.close()
  } catch { /* 忽略 */ }
})

// —— 透明度小滑条窗（托盘「透明度」入口）：1~100 实时拖动 ——
let opacityWin = null
function toggleOpacityWindow() {
  try {
    if (opacityWin && !opacityWin.isDestroyed()) {
      opacityWin.close()
      return
    }
    const wa = screen.getPrimaryDisplay().workArea
    const b = overlayWin && !overlayWin.isDestroyed() ? overlayWin.getBounds() : defaultOverlayBounds()
    let x = b.x + b.width - 260 // 与悬浮窗右缘对齐
    let y = b.y - 54 - 4 // 悬浮窗正上方
    if (y < wa.y) y = b.y + b.height + 4
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - 260)
    opacityWin = new BrowserWindow({
      width: 260,
      height: 54,
      x,
      y,
      frame: false,
      backgroundColor: '#1b1512',
      resizable: false,
      alwaysOnTop: config.alwaysOnTop !== false,
      skipTaskbar: true,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    opacityWin.setAlwaysOnTop(config.alwaysOnTop !== false, 'screen-saver')
    opacityWin.loadFile(path.join(__dirname, 'overlay', 'opacity.html'))
    opacityWin.webContents.on('did-finish-load', () => {
      try {
        opacityWin.webContents.send('push', { type: 'opacity-init', v: Number(config.overlayOpacity) || 1 })
      } catch { /* 忽略 */ }
    })
    opacityWin.on('closed', () => { opacityWin = null })
  } catch { /* 忽略 */ }
}

// —— 按键统计浮窗（近 7 天明细）：托盘入口 / 点悬浮窗计数器 ——
let keyStatsWin = null
function toggleKeyStatsWindow() {
  try {
    if (keyStatsWin && !keyStatsWin.isDestroyed()) {
      keyStatsWin.close()
      return
    }
    const wa = screen.getPrimaryDisplay().workArea
    const b = overlayWin && !overlayWin.isDestroyed() ? overlayWin.getBounds() : defaultOverlayBounds()
    let x = b.x + b.width - 250 // 与悬浮窗右缘对齐
    let y = b.y - 208 - 4 // 悬浮窗正上方
    if (y < wa.y) y = b.y + b.height + 4
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - 250)
    keyStatsWin = new BrowserWindow({
      width: 250,
      height: 208,
      x,
      y,
      frame: false,
      backgroundColor: '#1b1512',
      resizable: false,
      alwaysOnTop: config.alwaysOnTop !== false,
      skipTaskbar: true,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    keyStatsWin.setAlwaysOnTop(config.alwaysOnTop !== false, 'screen-saver')
    keyStatsWin.loadFile(path.join(__dirname, 'overlay', 'keystats.html'))
    keyStatsWin.webContents.on('did-finish-load', () => {
      try {
        keyStatsWin.webContents.send('push', keyStatsAll())
      } catch { /* 忽略 */ }
    })
    keyStatsWin.on('closed', () => { keyStatsWin = null })
  } catch { /* 忽略 */ }
}
ipcMain.on('overlay-keystats-open', () => toggleKeyStatsWindow())
ipcMain.on('overlay-keystats-close', () => {
  try {
    if (keyStatsWin && !keyStatsWin.isDestroyed()) keyStatsWin.close()
  } catch { /* 忽略 */ }
})

// —— 鼠标轨迹浮窗（发光热力 + 淡连线 + 点击亮点，近 7 天切换）——
let mouseMapWin = null
function toggleMouseMapWindow() {
  try {
    if (mouseMapWin && !mouseMapWin.isDestroyed()) {
      mouseMapWin.close()
      return
    }
    const W = 680
    const H = 430
    const wa = screen.getPrimaryDisplay().workArea
    const x = Math.min(Math.max(wa.x + Math.round((wa.width - W) / 2), wa.x), wa.x + wa.width - W)
    const y = Math.min(Math.max(wa.y + Math.round((wa.height - H) / 3), wa.y), wa.y + wa.height - H)
    mouseMapWin = new BrowserWindow({
      width: W,
      height: H,
      x,
      y,
      frame: false,
      backgroundColor: '#171210',
      resizable: false,
      alwaysOnTop: config.alwaysOnTop !== false,
      skipTaskbar: true,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    mouseMapWin.setAlwaysOnTop(config.alwaysOnTop !== false, 'screen-saver')
    mouseMapWin.loadFile(path.join(__dirname, 'overlay', 'mousemap.html'))
    mouseMapWin.webContents.on('did-finish-load', () => {
      try {
        const days = mouseMapDays()
        mouseMapWin.webContents.send('push', {
          type: 'mousemap-init',
          days,
          data: mouseMapForDay(days[0] || todayKey()),
        })
      } catch { /* 忽略 */ }
    })
    mouseMapWin.on('closed', () => { mouseMapWin = null })
  } catch { /* 忽略 */ }
}
ipcMain.on('mousemap-day', (_e, date) => {
  try {
    if (mouseMapWin && !mouseMapWin.isDestroyed()) mouseMapWin.webContents.send('push', mouseMapForDay(String(date || '')))
  } catch { /* 忽略 */ }
})
ipcMain.on('overlay-mousemap-close', () => {
  try {
    if (mouseMapWin && !mouseMapWin.isDestroyed()) mouseMapWin.close()
  } catch { /* 忽略 */ }
})

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
  const intervalItem = (c) => ({
    label: c.label,
    type: 'radio',
    checked: config.minAttackIntervalMs === c.ms,
    click: () => {
      config.minAttackIntervalMs = c.ms
      saveConfig()
      tray.setContextMenu(trayMenu())
    },
  })
  return Menu.buildFromTemplate([
    { label: '打开面板', click: () => openPanelView() },
    {
      label: '直达',
      submenu: [
        { label: '攻击一次', click: doAttack }, // 手动攻击不受间隔限制（与面板按钮一致）
        { label: '武器库', click: () => openPanelView('arsenal') },
        { label: '怪物库', click: () => openPanelView('bestiary') },
      ],
    },
    { type: 'separator' },
    {
      label: '显示悬浮窗',
      type: 'checkbox',
      checked: config.showOverlay,
      click: (item) => {
        config.showOverlay = item.checked
        saveConfig()
        applyOverlayVisibility()
        tray.setContextMenu(trayMenu())
      },
    },
    {
      label: '悬浮窗置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop !== false,
      click: (item) => {
        config.alwaysOnTop = item.checked
        saveConfig()
        applyOverlayVisibility()
        tray.setContextMenu(trayMenu())
      },
    },
    SUPPORTS_OPACITY ? { label: '透明度调节…', click: () => toggleOpacityWindow() } : null,
    { label: '按键统计…', click: () => toggleKeyStatsWindow() },
    { label: '鼠标轨迹…', click: () => toggleMouseMapWindow() },
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
      label: '攻击间隔',
      submenu: INTERVAL_CHOICES.map(intervalItem),
    },
    SUPPORTS_AUTOLAUNCH
      ? {
          label: '开机自启',
          type: 'checkbox',
          checked: getAutoLaunch(),
          click: (item) => {
            setAutoLaunch(item.checked)
            tray.setContextMenu(trayMenu())
          },
        }
      : null,
    { type: 'separator' },
    hookErr
      ? {
          label: '⚠️ 键盘监听不可用（点这里看原因）',
          click: () => {
            dialog.showMessageBox({
              type: 'warning',
              title: '全局键盘监听不可用',
              message: '敲空格 / 回车目前无法被 Nibble 捕获',
              detail: hookTroubleDetail(),
              buttons: ['好'],
            })
          },
        }
      : null,
    {
      label: '关于 Nibble',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: '关于 Nibble',
          message: 'Nibble Desktop v' + app.getVersion(),
          detail:
            '敲空格 / 回车，桌面上那只像素小生物就会向野生 Bug 发动攻击。\n\n' +
            '项目主页：https://github.com/LMLuo/nibble-desktop\n' +
            '游戏设定与像素素材来自 nibble（IDE 扩展版）。\n\n' +
            'MIT License · 零联网 · 无统计' +
            (IS_LINUX
              ? '\n\nLinux 版：全局按键依赖 X11 会话，当前会话为 ' + (WAYLAND ? 'Wayland（监听不可用）' : 'X11') + '。'
              : ''),
          buttons: ['好'],
        })
      },
    },
    {
      label: '退出 Nibble',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ].filter(Boolean)) // null = 当前平台不支持 / 当前状态不适用，直接滤掉
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.png'))
    tray.setToolTip('Nibble · 敲空格 / 回车发起攻击')
    tray.setContextMenu(trayMenu())
    tray.on('double-click', () => openPanelView())
  } catch (err) {
    console.error('[nibble] 托盘创建失败：', err && err.message)
    // 托盘是唯一的常规入口（Linux 上没有 AppIndicator 时真会创建失败）：
    // 强制把悬浮窗留在桌面上，免得变成「看不见、也退不掉」的进程
    tray = null
    config.showOverlay = true
  }
}

// ============================ 渲染层消息 ============================
// 面板（pet.js 通过 acquireVsCodeApi shim 发来）
ipcMain.on('panel-msg', (_e, msg) => {
  if (!msg) return
  if (msg.type === 'ready') {
    // 页面（重）加载后拿全量数据：清掉所有「变化检测」缓存
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

// 从 ipc 事件定位来源窗口（拖动 / 关闭等，支持悬浮窗与弹层两个窗口）
const winOf = (e) => {
  try {
    const w = BrowserWindow.fromWebContents(e.sender)
    return w && !w.isDestroyed() ? w : null
  } catch {
    return null
  }
}

// 点击小生物 / 武器槽 / 直达按钮 → 弹出层（可选直达 tab）
ipcMain.on('overlay-open-panel', () => openPanelView())
ipcMain.on('overlay-open-view', (_e, v) => openPanelView(v === 'bestiary' ? 'bestiary' : 'arsenal'))
// 弹层标题栏「─」/ 面板「战斗」tab → 关闭弹层回舞台
ipcMain.on('overlay-collapse', () => closeView())
// 手动拖动：来源窗口跟随鼠标位移（带边界钳制，拖不出屏幕）
ipcMain.on('overlay-move-by', (e, dx, dy) => {
  try {
    const w = winOf(e)
    if (!w) return
    const b = w.getBounds()
    const wa = screen.getPrimaryDisplay().workArea
    let x = b.x + (Number(dx) || 0)
    let y = b.y + (Number(dy) || 0)
    const minX = wa.x - b.width + 80
    x = Math.min(Math.max(x, minX), wa.x + wa.width - 80)
    y = Math.min(Math.max(y, wa.y - 20), wa.y + wa.height - 40)
    w.setPosition(x, y)
  } catch { /* 忽略 */ }
})
ipcMain.on('overlay-move-end', (e) => {
  if (winOf(e) === overlayWin) saveOverlayPos() // 只记忆悬浮窗位置（弹层每次跟随悬浮窗定位）
})
ipcMain.on('overlay-ready', () => {
  lastKey = ''
  tick()
  pushKeyStatsToday() // 计数器初值（今天可能已有存量计数）
})

function pushKeyStatsToday() {
  const day = todayKey()
  const rec = keyStats.days[day] || { space: 0, enter: 0 }
  broadcast({ type: 'keystats', today: { date: day, space: Number(rec.space) || 0, enter: Number(rec.enter) || 0 } })
}

// ============================ 生命周期 ============================
const gotLock = app.requestSingleInstanceLock()
if (!gotLock && !diagOn) {
  // 诊断模式绕开单实例锁：可与用户正在运行的实例共存（仅多一个窗口，数秒后自动退出）
  app.quit()
} else {
  app.on('second-instance', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.show()
    openPanelView()
  })

  app.whenReady().then(() => {
    loadConfig()
    loadKeyStats()
    loadMouseTrack()
    setInterval(() => {
      saveKeyStatsIfDirty() // 键盘计数防抖落盘
      saveMouseTrackIfDirty() // 鼠标轨迹防抖落盘
    }, 30000)
    createOverlay()
    startHook() // 必须早于 createTray：监听失败时托盘要多出一条「键盘监听不可用」入口
    createTray()

    // 首次启动：写配置文件（此后 isFirstRun 为 false）+ 自动展开一次面板 + 一句欢迎
    if (isFirstRun()) {
      config.showOverlay = true
      saveConfig()
      try {
        const s = sp.loadSave()
        if (!s.lastLog) {
          s.lastLog = '欢迎！敲空格 / 回车发起攻击，点击小生物展开面板'
          s.logKind = 'idle'
          sp.saveSave()
        }
      } catch { /* 忽略 */ }
      openPanelView()
    }

    warnWaylandOnce() // 放在首次启动之后：Wayland 警告要盖过欢迎语（它更紧急）
    applyOverlayVisibility()
    setInterval(tick, 100) // 10fps 节拍：像素动画（呼吸/前冲/消散）顺滑
    tick()

    // 诊断模式：3 秒时可选展开一次（NIBBLE_DIAG_EXPAND=arsenal|bestiary|1），
    // 6 秒后截屏（验证紧凑态/展开态是否真的渲染），随后退出
    if (diagOn) {
      diagLog('diag start (expand=' + (process.env.NIBBLE_DIAG_EXPAND || 'none') + ')')
      // 模拟敲击：验证 计数 → 广播 → 计数器渲染 全链路
      setTimeout(() => {
        bumpKeyStat('space')
        bumpKeyStat('space')
        bumpKeyStat('enter')
        diagLog('bumpKeyStat x3 done')
      }, 2000)
      // 模拟鼠标轨迹并打开轨迹浮窗（NIBBLE_DIAG_MOUSEMAP=1）
      if (process.env.NIBBLE_DIAG_MOUSEMAP) {
        setTimeout(() => {
          for (let i = 0; i < 260; i++) {
            recordMouse(300 + i * 5, 420 + Math.round(Math.sin(i / 11) * 230), false)
          }
          for (let i = 0; i < 14; i++) recordMouse(760 + i * 42, 720, true)
          const rec = mouseDays.days[todayKey()] || {}
          diagLog('mouse sim done, cells=' + Object.keys(rec.cells || {}).length + ' path=' + ((rec.path || []).length) + ' clicks=' + ((rec.clicks || []).length))
          toggleMouseMapWindow()
          diagLog('mousemap win=' + JSON.stringify(mouseMapWin && !mouseMapWin.isDestroyed() ? mouseMapWin.getBounds() : null))
        }, 3200)
      }
      const expandTarget = process.env.NIBBLE_DIAG_EXPAND
      if (expandTarget) {
        setTimeout(() => {
          diagLog('expand -> ' + expandTarget)
          openPanelView(expandTarget === 'bestiary' ? 'bestiary' : expandTarget === 'arsenal' ? 'arsenal' : null)
          diagLog('expand done, overlay=' + JSON.stringify(overlayWin && overlayWin.getBounds()) +
            ' view=' + JSON.stringify(viewWin && !viewWin.isDestroyed() ? viewWin.getBounds() : null))
        }, 3000)
      }
      setTimeout(async () => {
        try {
          diagLog('capture begin')
          if (overlayWin && !overlayWin.isDestroyed()) {
            const img = await Promise.race([
              overlayWin.webContents.capturePage(),
              new Promise((r) => setTimeout(() => r(null), 5000)),
            ])
            if (img) {
              const out = diagOut || path.join(app.getPath('temp'), 'nibble-diag.png')
              fs.writeFileSync(out, img.toPNG())
              diagLog('capture saved: ' + out + ' ' + img.getSize().width + 'x' + img.getSize().height)
            } else {
              diagLog('capture timed out (no frame)')
            }
            // DOM 探测：验证展开态是否真的可见、内容高度与滚动能力
            const probe = await overlayWin.webContents.executeJavaScript(`(() => {
              const q = (id) => document.getElementById(id)
              const box = (el) => el ? (function(r){return {w:Math.round(r.width),h:Math.round(r.height),sh:el.scrollHeight,ch:el.clientHeight,disp:getComputedStyle(el).display,of:getComputedStyle(el).overflowY}})(el.getBoundingClientRect()) : null
              return JSON.stringify({
                fullClass: document.body.classList.contains('full'),
                compact: box(q('compact')),
                phud: box(q('o-phud')),
                wslot: box(q('o-wslot')),
                aura: box(q('o-aura')),
                logtext: box(q('o-logtext')),
                quick: box(q('o-quick')),
                player: box(q('o-player')),
                enemy: box(q('o-enemy')),
                lvText: (q('o-lv') || {}).textContent || '',
                wnameText: (q('o-wname') || {}).textContent || '',
                logText: (q('o-logtext') || {}).textContent || '',
                keycountText: (q('o-keycount') || {}).textContent || '',
                win: { w: innerWidth, h: innerHeight }
              })
            })()`)
            diagLog('probe overlay: ' + probe)
            // 弹层窗口：独立截图 + probe
            if (viewWin && !viewWin.isDestroyed()) {
              const img2 = await Promise.race([
                viewWin.webContents.capturePage(),
                new Promise((r) => setTimeout(() => r(null), 5000)),
              ])
              if (img2) {
                const out2 = (diagOut || path.join(app.getPath('temp'), 'nibble-diag.png')).replace(/\.png$/, '-view.png')
                fs.writeFileSync(out2, img2.toPNG())
                diagLog('capture view: ' + out2 + ' ' + img2.getSize().width + 'x' + img2.getSize().height)
              }
              const probe2 = await viewWin.webContents.executeJavaScript(`(() => {
                const q = (id) => document.getElementById(id)
                const box = (el) => el ? (function(r){return {w:Math.round(r.width),h:Math.round(r.height),sh:el.scrollHeight,ch:el.clientHeight,disp:getComputedStyle(el).display}})(el.getBoundingClientRect()) : null
                return JSON.stringify({
                  hash: location.hash,
                  fullClass: document.body.classList.contains('full'),
                  compact: box(q('compact')),
                  full: box(q('full')),
                  fb: box(q('fullBody')),
                  arsenal: box(q('arsenalView')),
                  cells: document.querySelectorAll('#agroups .wcell').length,
                  win: { w: innerWidth, h: innerHeight }
                })
              })()`)
              diagLog('probe view: ' + probe2)
            } else {
              diagLog('viewWin missing at capture time')
            }
            // 鼠标轨迹浮窗（若打开）
            if (mouseMapWin && !mouseMapWin.isDestroyed()) {
              const img3 = await Promise.race([
                mouseMapWin.webContents.capturePage(),
                new Promise((r) => setTimeout(() => r(null), 5000)),
              ])
              if (img3) {
                const out3 = (diagOut || path.join(app.getPath('temp'), 'nibble-diag.png')).replace(/\.png$/, '-map.png')
                fs.writeFileSync(out3, img3.toPNG())
                diagLog('capture map: ' + out3 + ' ' + img3.getSize().width + 'x' + img3.getSize().height)
              }
              const probe3 = await mouseMapWin.webContents.executeJavaScript(`JSON.stringify({
                days: document.querySelectorAll('.day').length,
                label: (document.getElementById('dateLabel') || {}).textContent,
                cv: (function (c) { return c ? { w: c.width, h: c.height } : null })(document.getElementById('cv'))
              })`)
              diagLog('probe map: ' + probe3)
            } else {
              diagLog('mouseMapWin missing at capture time')
            }
          } else {
            diagLog('overlayWin missing at capture time')
          }
        } catch (err) {
          diagLog('capture failed: ' + (err && err.message))
        }
        app.exit(0)
      }, 6000)
    }
  })

  // 托盘常驻应用：窗口全关也不退出
  app.on('window-all-closed', () => { /* no-op */ })

  app.on('before-quit', () => {
    quitting = true
    saveKeyStatsIfDirty() // 退出前落盘未保存的敲击计数
    saveMouseTrackIfDirty() // 与鼠标轨迹
    try {
      if (hook) hook.stop()
    } catch { /* 忽略 */ }
  })

  // macOS 惯例（桌面版以 Windows 为主，保留兜底）
  app.on('activate', () => {
    if (app.isReady() && !overlayWin) createOverlay()
  })
}
