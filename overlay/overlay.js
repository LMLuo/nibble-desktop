'use strict'
// overlay.js —— 悬浮窗（单窗口双形态）：
//   紧凑层 #compact：迷你战斗舞台，id 带 o- 前缀；整窗可交互（拖动 / 点击 / 滚轮调透明度）
//   展开层 #full：完整面板（pet.js / scene.js 操作，DOM id 与 IDE 扩展的 panel.html 保持一致，零改动复用）

;(function () {
  const SIZE = 24
  const $ = (id) => document.getElementById(id)
  const canvasP = $('o-player')
  const canvasE = $('o-enemy')
  const dmgEl = $('o-dmg')

  let state = null
  let tick = { frame: 0, lunge: false, dissolve: false }
  let lastLunge = false
  let dmg = { val: 0, ticks: 0 }
  let fullMode = false

  const isFull = () => document.body.classList.contains('full')

  // 弹层窗口以 index.html#full 加载：初始直接显示完整层（不闪紧凑层）
  if (location.hash === '#full') {
    document.body.classList.add('full')
    const ff = $('full')
    if (ff) ff.classList.remove('hidden')
    fullMode = true
  }

  // 把 24x24 扁平颜色数组画到 canvas（'' = 透空；alpha 用于稀有怪呼吸闪烁而非消失）
  function drawSprite(canvas, flatGrid, shiftX, shiftY, hidden, alpha) {
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, SIZE, SIZE)
    if (!flatGrid || hidden) return
    ctx.globalAlpha = alpha == null ? 1 : alpha
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const color = flatGrid[r * SIZE + c]
        if (!color) continue
        const x = c + shiftX
        const y = r + shiftY
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
        ctx.fillStyle = color
        ctx.fillRect(x, y, 1, 1)
      }
    }
    ctx.globalAlpha = 1
  }

  // ============================================================
  // 像素场景背景（对齐扩展战斗页的三套主题 = 三个怪物 tier）
  // 天空带 → 星星 → 阶梯远山 → 地面带；纯 fillRect 硬边，无平滑
  // ============================================================
  var THEMES = {
    common: { sky: '#C2D6E2', sky2: '#EEF3F3', far: '#ACBECE', hill: '#7C9C58', hillTop: '#93B26C',
      ground: '#8FB061', groundTop: '#A6C674', grass: '#587A38' },
    elite: { sky: '#241E30', sky2: '#4C4058', far: '#322C42', hill: '#3E4A42', hillTop: '#4E5C50',
      ground: '#46524A', groundTop: '#56645A', star: '#c8bcd8' },
    boss: { sky: '#180A0A', sky2: '#48190E', far: '#381412', hill: '#5A2016', hillTop: '#6E2A1A',
      ground: '#6A2816', groundTop: '#8A3620', star: '#ff9a5a' },
  }
  var lastSceneTier = null

  // 阶梯三角山：每 3px 一层向内收
  function drawHill(ctx, cx, baseY, half, hgt, color) {
    ctx.fillStyle = color
    for (let i = 0; i < hgt; i += 3) {
      const ww = Math.max(2, Math.round(half * (1 - i / hgt)))
      ctx.fillRect(cx - ww, baseY - i - 3, ww * 2, 3)
    }
  }

  function drawScene(tier) {
    const cv = $('o-bg')
    const w = cv.parentElement.clientWidth
    const h = cv.parentElement.clientHeight
    if (!w || !h) return
    if (cv.width !== w) cv.width = w
    if (cv.height !== h) cv.height = h
    const ctx = cv.getContext('2d')
    const t = THEMES[tier] || THEMES.common
    const g = Math.round(h * 0.72) // 地平线
    const mid = Math.round(g * 0.55)

    // 天空两带
    ctx.fillStyle = t.sky
    ctx.fillRect(0, 0, w, mid)
    ctx.fillStyle = t.sky2
    ctx.fillRect(0, mid, w, g - mid)

    // 星星（夜主题）
    if (t.star) {
      ctx.fillStyle = t.star
      const pts = [[0.08, 0.18], [0.18, 0.42], [0.3, 0.12], [0.45, 0.3], [0.55, 0.1], [0.66, 0.36], [0.78, 0.16], [0.9, 0.34]]
      for (const p of pts) ctx.fillRect(Math.round(p[0] * w), Math.round(p[1] * mid), 2, 2)
    }

    // 远山两座（阶梯）
    drawHill(ctx, Math.round(w * 0.22), g, Math.round(w * 0.24), Math.round(g * 0.62), t.far)
    drawHill(ctx, Math.round(w * 0.72), g, Math.round(w * 0.3), Math.round(g * 0.48), t.hill)

    // 山顶亮边（顶部 3px 换亮色）
    drawHill(ctx, Math.round(w * 0.72), g, Math.round(w * 0.3), 3, t.hillTop)

    // 地面带 + 顶部亮边
    ctx.fillStyle = t.ground
    ctx.fillRect(0, g, w, h - g)
    ctx.fillStyle = t.groundTop
    ctx.fillRect(0, g, w, 5)
    // 地面深色地块点缀
    ctx.fillStyle = 'rgba(0,0,0,.14)'
    ctx.fillRect(Math.round(w * 0.1), g + 18, 22, 4)
    ctx.fillRect(Math.round(w * 0.52), g + 30, 30, 4)
    ctx.fillRect(Math.round(w * 0.82), g + 12, 16, 4)

    // 草丛（白天主题才有）
    if (t.grass) {
      ctx.fillStyle = t.grass
      const gx = [0.06, 0.16, 0.4, 0.62, 0.88]
      for (const p of gx) ctx.fillRect(Math.round(p * w), g - 4, 2, 4)
    }
    lastSceneTier = tier
  }

  const enemyRatio = () => (state ? Math.max(0, state.hp) / Math.max(1, state.maxHp) : 1)
  const HP_COLORS = { ok: '#A6C674', mid: '#FFD75E', low: '#FF6B6B' }
  const hpColor = () => {
    const r = enemyRatio()
    return r > 0.5 ? HP_COLORS.ok : r > 0.25 ? HP_COLORS.mid : HP_COLORS.low
  }

  function render() {
    if (!state) return
    // 玩家：攻击前冲 2px，待机隔帧下沉 1px
    const lunge = tick.lunge
    drawSprite(canvasP, state.player, lunge ? 2 : 0, lunge ? 0 : (tick.frame ? 1 : 0), false)
    // 敌人：击败消散隔帧闪烁；稀有/传说 = 透明度呼吸（绝不整只消失）
    const enemyHidden = tick.dissolve && tick.frame % 2 === 0
    drawSprite(canvasE, state.enemy, 0, 0, enemyHidden, tick.blink ? 0.65 : 1)
    // 伤害飘字
    if (dmg.ticks > 0) {
      dmgEl.textContent = '-' + dmg.val
      dmgEl.classList.toggle('hidden', false)
      dmgEl.classList.toggle('crit', state && state.streakTier >= 2)
    } else {
      dmgEl.classList.toggle('hidden', true)
    }
    // 敌人信息
    const bar = $('o-ehp')
    bar.style.width = Math.round(enemyRatio() * 100) + '%'
    bar.style.background = hpColor()
    const nameEl = $('o-ename')
    nameEl.textContent = state.enemyName + ' ' + state.hp + '/' + state.maxHp
    nameEl.style.color = state.rarityColor || '#efe3d2'
    // HUD
    $('o-lv').textContent = 'Lv ' + state.level
    const need = Math.max(1, state.xpNeed || 1)
    $('o-exp').style.width = Math.max(0, Math.min(100, Math.round(((state.exp || 0) / need) * 100))) + '%'
    const comboEl = $('o-combo')
    if (state.streak >= 10) {
      comboEl.textContent = '×' + state.streak
      comboEl.classList.toggle('hidden', false)
    } else {
      comboEl.classList.toggle('hidden', true)
    }
    // 武器槽（对齐扩展装备槽）：恒显，未装备 = 灰态占位
    const slot = $('o-wslot')
    const hasW = !!state.weaponSprite
    slot.classList.remove('hidden')
    slot.classList.toggle('empty', !hasW)
    slot.style.borderColor = hasW ? (state.weaponColor || 'rgba(216,192,138,.3)') : ''
    drawSprite($('o-wicon'), state.weaponSprite, 0, 0, !hasW)
    $('o-wname').textContent = hasW ? state.weaponName + ' +' + (state.weaponPower || 0) + '%' : '未装备'
    slot.title = hasW
      ? state.weaponName + ' · 战力 +' + (state.weaponPower || 0) + '% · 点击打开武器库'
      : '点击打开武器库'
    // 战绩 hover 提示
    $('o-hud').title = '攻击 ' + (state.battles || 0) + ' 次 · 击败 ' + (state.defeats || 0) + ' 次 · 连击 ×' + (state.streak || 0)
    // 日志（去掉 emoji / 星号，同 pet.js 的处理）
    $('o-log').textContent = (state.log || 'Nibble 待命中…').replace(/🆕|💚|🧬/g, '').replace(/\*\*/g, '')
  }

  function applyState(msg) {
    const tierChanged = !state || state.enemyTier !== msg.enemyTier
    state = Object.assign({}, state, msg)
    if (tierChanged && !isFull()) drawScene(state.enemyTier)
    render()
  }

  function setMode(full, opacity) {
    fullMode = !!full
    document.body.classList.toggle('full', fullMode)
    // 双保险：显式同步 #full 的 hidden 类（历史上曾因它被 !important 永久隐藏而黑屏）
    const fullEl = $('full')
    if (fullEl) fullEl.classList.toggle('hidden', !fullMode)
    if (fullMode && opacity != null) {
      const slider = $('o-opacity')
      if (slider) slider.value = Math.round(opacity * 100)
    }
    // v0.5：窗口尺寸恒定（300×220），切层不再触发 resize，无需重画场景
  }

  function onMessage(msg) {
    if (!msg) return
    if (msg.type === 'state') {
      applyState(msg)
    } else if (msg.type === 'tick') {
      tick = msg
      if (dmg.ticks > 0) dmg.ticks--
      // 攻击上升沿 → 弹伤害飘字（0 = 未命中，跳过）
      if (msg.lunge && !lastLunge && state && state.lastDmg > 0) {
        dmg.val = state.lastDmg
        dmg.ticks = 3
      }
      lastLunge = !!msg.lunge
      if (state) {
        state.hp = msg.hp
        state.maxHp = msg.maxHp
        state.level = msg.level
        state.log = msg.log
      }
      render()
    } else if (msg.type === 'mode') {
      setMode(!!msg.full, msg.opacity)
    }
    // view：由 pet.js 处理（切武器库/怪物库 tab）；drop / burst：紧凑层不重复演出
  }

  window.addEventListener('message', (e) => onMessage(e.data || {}))

  // ============================================================
  // 交互：紧凑态整窗可拖（原地点击 = 生物展开 / 武器槽直达 / 快捷按钮）
  //       展开态标题栏拖动 + 透明度滑条；紧凑态滚轮调透明度
  // ============================================================
  let drag = null // { moved, action }  action: 'panel' | 'arsenal' | 'bestiary' | null
  const CLICK_PX = 5 // 位移小于该值视为点击（而非拖动）

  function compactAction(target) {
    if (!target || !target.closest) return null
    if (target.closest('#o-player')) return 'panel'
    if (target.closest('#o-wslot')) return 'arsenal'
    if (target.closest('#o-open-arsenal')) return 'arsenal'
    if (target.closest('#o-open-bestiary')) return 'bestiary'
    return null
  }

  function fireAction(action) {
    try {
      if (action === 'panel') window.nibbleOverlay.openPanel()
      else if (action === 'arsenal') window.nibbleOverlay.openView('arsenal')
      else if (action === 'bestiary') window.nibbleOverlay.openView('bestiary')
    } catch { /* 忽略 */ }
  }

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest) return
    if (isFull()) {
      // 展开态：标题栏拖动（滑条与收起按钮除外）
      if (e.target.closest('#o-titlebar') && !e.target.closest('#o-opacity') && !e.target.closest('#o-collapse')) {
        drag = { moved: 0, action: null }
        e.preventDefault()
      }
      return
    }
    // 紧凑态：整窗按住即拖；原地点击触发对应动作
    if (e.target.closest('#o-opacity')) return
    drag = { moved: 0, action: compactAction(e.target) }
    e.preventDefault()
  })
  document.addEventListener('mousemove', (e) => {
    if (!drag) return
    drag.moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0)
    if (drag.moved > CLICK_PX) {
      try {
        window.nibbleOverlay.moveBy(e.movementX || 0, e.movementY || 0)
      } catch { /* 忽略 */ }
    }
  })
  document.addEventListener('mouseup', () => {
    if (!drag) return
    const d = drag
    drag = null
    if (d.moved > CLICK_PX) {
      try {
        window.nibbleOverlay.moveEnd()
      } catch { /* 忽略 */ }
    } else if (d.action) {
      fireAction(d.action) // 原地点击
    }
  })
  document.addEventListener('mouseleave', () => {
    drag = null
  })
  window.addEventListener('blur', () => {
    drag = null
  })

  // 紧凑态滚轮：调透明度（上滚更实 / 下滚更透）
  document.addEventListener('wheel', (e) => {
    if (isFull()) return
    try {
      window.nibbleOverlay.opacityDelta(e.deltaY < 0 ? 0.05 : -0.05)
    } catch { /* 忽略 */ }
  }, { passive: true })

  // 展开态标题栏滑条：调透明度
  $('o-opacity').addEventListener('input', (e) => {
    try {
      window.nibbleOverlay.opacitySet(Number(e.target.value) / 100)
    } catch { /* 忽略 */ }
  })
  // 标题栏「─」→ 收起回迷你舞台
  $('o-collapse').addEventListener('click', () => {
    try {
      window.nibbleOverlay.collapse()
    } catch { /* 忽略 */ }
  })
  // 面板 nav 的「战斗」tab：小窗里它等同于回迷你舞台（pet.js 也会切 battleView，双触发无害）
  const tabBattle = $('tabBattle')
  if (tabBattle) {
    tabBattle.addEventListener('click', () => {
      try {
        window.nibbleOverlay.collapse()
      } catch { /* 忽略 */ }
    })
  }

  // 就绪：消息监听已挂上，让主进程立即重推全量状态
  if (document.readyState === 'complete') notifyReady()
  else window.addEventListener('load', notifyReady)

  function notifyReady() {
    try {
      window.nibbleOverlay.ready()
    } catch { /* 桥未就绪时忽略，主进程 400ms 节拍随后会补推 */ }
    // 布局就绪兜底：若 state 已到但场景还没画成功（取尺寸失败），补一次
    if (state && !isFull() && lastSceneTier !== state.enemyTier) drawScene(state.enemyTier)
  }
})()
