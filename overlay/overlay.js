'use strict'
// overlay.js —— 悬浮窗的绘制与交互（游戏数据由主进程经 preload 桥推送）
//
// 穿透策略：窗口默认 setIgnoreMouseEvents(true, {forward:true})；
// 鼠标悬停到 .hot 热区（小生物 / HUD 条）时通过 nibbleOverlay.hover(true) 关闭穿透，
// 此时 HUD 条的 -webkit-app-region:drag 生效（拖动位置），点击小生物打开面板。

;(function () {
  const SIZE = 24
  const $ = (id) => document.getElementById(id)
  const canvasP = $('player')
  const canvasE = $('enemy')
  const dmgEl = $('dmg')

  let state = null
  let tick = { frame: 0, lunge: false, dissolve: false }
  let lastLunge = false
  let dmg = { val: 0, ticks: 0 }
  let hoverOn = false

  // 把 24x24 扁平颜色数组画到 canvas（'' = 透空），与 pet.js 同一套实现
  function drawSprite(canvas, flatGrid, shiftX, shiftY, hidden) {
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, SIZE, SIZE)
    if (!flatGrid || hidden) return
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
    // 敌人：击败消散隔帧闪烁 / 稀有怪亮点闪烁
    drawSprite(canvasE, state.enemy, 0, 0, (tick.dissolve && tick.frame % 2 === 0) || (tick.blink && tick.frame === 0))
    // 伤害飘字
    if (dmg.ticks > 0) {
      dmgEl.textContent = '-' + dmg.val
      dmgEl.classList.toggle('hidden', false)
      dmgEl.classList.toggle('crit', state && state.streakTier >= 2)
    } else {
      dmgEl.classList.toggle('hidden', true)
    }
    // 敌人信息
    const bar = $('ehp')
    bar.style.width = Math.round(enemyRatio() * 100) + '%'
    bar.style.background = hpColor()
    const nameEl = $('ename')
    nameEl.textContent = state.enemyName + ' ' + state.hp + '/' + state.maxHp
    nameEl.style.color = state.rarityColor || '#efe3d2'
    // HUD
    $('lv').textContent = 'Lv ' + state.level
    const need = Math.max(1, state.xpNeed || 1)
    $('exp').style.width = Math.max(0, Math.min(100, Math.round(((state.exp || 0) / need) * 100))) + '%'
    const comboEl = $('combo')
    if (state.streak >= 10) {
      comboEl.textContent = '×' + state.streak
      comboEl.classList.toggle('hidden', false)
    } else {
      comboEl.classList.toggle('hidden', true)
    }
    // 日志（去掉 emoji / 星号，同 pet.js 的处理）
    $('log').textContent = (state.log || 'Nibble 待命中…').replace(/🆕|💚|🧬/g, '').replace(/\*\*/g, '')
  }

  function applyState(msg) {
    state = Object.assign({}, state, msg)
    render()
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
    }
    // drop / burst：悬浮窗不重复演出（日志已包含掉落信息）
  }

  window.addEventListener('message', (e) => onMessage(e.data || {}))

  // —— 热区穿透切换 ——
  function setHover(on) {
    if (on === hoverOn) return
    hoverOn = on
    try {
      window.nibbleOverlay.hover(on)
    } catch { /* 桥未就绪 */ }
  }
  document.addEventListener('mousemove', (e) => {
    const hot = !!(e.target && e.target.closest && e.target.closest('.hot'))
    setHover(hot)
  })
  document.addEventListener('mouseleave', () => setHover(false))
  window.addEventListener('blur', () => setHover(false))

  canvasP.addEventListener('click', () => {
    try {
      window.nibbleOverlay.openPanel()
    } catch { /* 忽略 */ }
  })

  // 就绪：消息监听已挂上，让主进程立即重推全量状态
  if (document.readyState === 'complete') notifyReady()
  else window.addEventListener('load', notifyReady)

  function notifyReady() {
    try {
      window.nibbleOverlay.ready()
    } catch { /* 桥未就绪时忽略，主进程 400ms 节拍随后会补推 */ }
  }
})()
