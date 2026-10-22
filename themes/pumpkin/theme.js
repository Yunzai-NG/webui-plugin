/**
 * YUNZAI NG 主题（id 为 pumpkin）的脚本
 *
 * 只做样式表做不到的四件事，换主题或进安全模式时由返回的收尾函数全部撤掉：
 * 1. 浏览器地址栏 / 手机状态栏的颜色（`<meta name="theme-color">`）跟着明暗换；
 * 2. 拨开关时滑块弹一下：拨开撒出一把种子，拨关落下两片叶子；
 * 3. 指针在概览页的格子上移动时，卡片上跟着一团很淡的橙光；
 * 4. 指针停在卡片上时，卡片朝指针微微倾斜。
 *
 * 后三件是动效：低功耗开着、或外观页关了动效时不做。种子、叶子、光斑与倾斜的样式写在 theme.css 里。
 *
 * **撒出来的东西要挂在开关所在的那一层。** 模态是 `showModal()` 打开的原生 `<dialog>`，渲染在
 * top layer，挂在 `<body>` 上的东西一律被它压在底下 —— 配置框、添加账号框里的开关因此看上去
 * 「没有撒种子」。故挂进最近的那个打开着的 `<dialog>`；坐标照视口算，挂上去之后再按它的实际
 * 位置校一次（对话框带着 transform 时，fixed 定位的参照就不再是视口）。
 */

/** 地址栏颜色，与 theme.css 的 `--bg` 一致 */
const BAR = { light: "#faf7f2", dark: "#0b1220" }

/** 一次撒几颗种子 */
const SEEDS = 7

/** 一次落几片叶子 */
const LEAVES = 2

/** 同时在场的上限：连着拨十几下也不会把页面撒满 */
const MAX_LIVE = 48

/**
 * @param {import("../../web/src/themes.js").ThemeScriptContext} ctx 面板给的上下文
 * @returns {() => void} 收尾
 */
export default function setup(ctx) {
  const cleanups = []

  // 1. 地址栏颜色：面板自己没有这枚 meta，由主题加、由主题撤
  const meta = document.createElement("meta")
  meta.name = "theme-color"
  meta.content = BAR[ctx.scheme()]
  document.head.append(meta)
  ctx.onSchemeChange(scheme => {
    meta.content = BAR[scheme]
  })
  cleanups.push(() => meta.remove())

  const lively = () => ctx.motion() && !ctx.lowPower()

  // 2. 拨开关
  const live = new Set()

  /**
   * 挂一个承载层到开关所在的那一层，并量出它的 fixed 参照相对视口的偏移
   * @param {Element} near 开关
   * @returns {{ layer: HTMLElement, dx: number, dy: number }} 承载层与偏移
   */
  const layerFor = near => {
    const host = near.closest("dialog[open]") ?? document.body
    const layer = document.createElement("span")
    layer.className = "pk-burst"
    layer.setAttribute("aria-hidden", "true")
    host.append(layer)
    const box = layer.getBoundingClientRect()
    return { layer, dx: box.left, dy: box.top }
  }

  /**
   * 放一颗粒子并让它飞
   * @param {HTMLElement} layer 承载层
   * @param {string} kind 种类：`seed` / `sky` / `leaf`
   * @param {number} x 起点（承载层坐标）
   * @param {number} y 起点
   * @param {Keyframe[]} frames 关键帧
   * @param {number} duration 时长
   */
  const fly = (layer, kind, x, y, frames, duration) => {
    const bit = document.createElement("span")
    bit.className = `pk-bit pk-${kind}`
    bit.style.left = `${x}px`
    bit.style.top = `${y}px`
    layer.append(bit)
    const anim = bit.animate(frames, { duration, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" })
    anim.onfinish = () => {
      bit.remove()
      if (layer.childElementCount === 0) {
        layer.remove()
        live.delete(layer)
      }
    }
  }

  const onChange = event => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.type !== "checkbox" || !lively()) return
    const sw = input.closest('.switch, [data-part~="switch"]')
    const track = sw?.querySelector(".switch-track")
    if (sw === null || sw === undefined || track === null || track === undefined) return
    if (live.size >= MAX_LIVE / SEEDS) return

    // 滑块弹一下：和 transform 分开写 scale，不打断它本身的滑动过渡
    track.animate(
      [{ scale: "1" }, { scale: input.checked ? "1.08" : "0.94" }, { scale: "1" }],
      { duration: 360, easing: "cubic-bezier(.34,1.56,.64,1)" }
    )

    const box = track.getBoundingClientRect()
    const { layer, dx, dy } = layerFor(sw)
    live.add(layer)
    const r = box.height / 2
    // 滑块的终点：开在右端、关在左端
    const x = (input.checked ? box.right - r : box.left + r) - dx
    const y = box.top + r - dy

    if (input.checked) {
      for (let i = 0; i < SEEDS; i++) {
        const angle = -Math.PI / 2 + (i - (SEEDS - 1) / 2) * 0.4 + (Math.random() - 0.5) * 0.2
        const dist = 24 + Math.random() * 18
        const ox = Math.cos(angle) * dist
        const oy = Math.sin(angle) * dist
        const spin = (Math.random() - 0.5) * 520
        fly(layer, i % 3 === 1 ? "sky" : "seed", x, y, [
          { transform: "translate(-50%, -50%) scale(.3)", opacity: 0 },
          { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.12 },
          { transform: `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px)) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.55 },
          { transform: `translate(calc(-50% + ${ox * 1.25}px), calc(-50% + ${oy + 30}px)) rotate(${spin}deg) scale(.6)`, opacity: 0 }
        ], 760 + Math.random() * 220)
      }
    } else {
      for (let i = 0; i < LEAVES; i++) {
        const side = i === 0 ? -1 : 1
        const drift = side * (10 + Math.random() * 10)
        fly(layer, "leaf", x, y - 2, [
          { transform: "translate(-50%, -50%) rotate(0deg) scale(.4)", opacity: 0 },
          { transform: `translate(calc(-50% + ${drift * 0.3}px), calc(-50% - 6px)) rotate(${side * 30}deg) scale(1)`, opacity: 1, offset: 0.2 },
          { transform: `translate(calc(-50% + ${drift}px), calc(-50% + 16px)) rotate(${side * -20}deg)`, opacity: 0.9, offset: 0.6 },
          { transform: `translate(calc(-50% + ${drift * 0.6}px), calc(-50% + 34px)) rotate(${side * 40}deg) scale(.8)`, opacity: 0 }
        ], 1000 + Math.random() * 200)
      }
    }
  }
  document.addEventListener("change", onChange)
  cleanups.push(() => {
    document.removeEventListener("change", onChange)
    for (const layer of live) layer.remove()
    live.clear()
  })

  // 3. 格子上的光斑：只跟鼠标，触屏上没有「悬停」这回事；一帧只写一次
  let frame = 0
  let pending
  const spotRoot = ctx.root
  const onMove = event => {
    if (event.pointerType !== "mouse" || !lively()) return
    const card = event.target instanceof Element ? event.target.closest('[data-part~="widget.frame"] .card') : null
    pending = card === null ? undefined : { card, x: event.clientX, y: event.clientY }
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (pending === undefined) return
      const box = pending.card.getBoundingClientRect()
      pending.card.style.setProperty("--pk-x", `${pending.x - box.left}px`)
      pending.card.style.setProperty("--pk-y", `${pending.y - box.top}px`)
    })
  }
  // 指针离开一张卡片时把光斑挪出去，不留在原处
  const onLeave = event => {
    const card = event.target instanceof Element ? event.target.closest('[data-part~="widget.frame"] .card') : null
    // 移进卡片里的子元素也会触发 pointerout，那不算离开
    if (card !== null && !(event.relatedTarget instanceof Node && card.contains(event.relatedTarget))) {
      card.style.removeProperty("--pk-x")
      card.style.removeProperty("--pk-y")
    }
  }
  spotRoot.dataset.pkSpot = "on"
  document.addEventListener("pointermove", onMove, { passive: true })
  document.addEventListener("pointerout", onLeave, { passive: true })
  cleanups.push(() => {
    document.removeEventListener("pointermove", onMove)
    document.removeEventListener("pointerout", onLeave)
    if (frame !== 0) cancelAnimationFrame(frame)
    delete spotRoot.dataset.pkSpot
    for (const card of document.querySelectorAll('[data-part~="widget.frame"] .card')) {
      card.style.removeProperty("--pk-x")
      card.style.removeProperty("--pk-y")
    }
  })

  // 4. 卡片朝指针微微倾斜：插件页、插件市场、面板商店的卡片，与概览页的组件格子（编辑版面时不倾斜，免得和拖动打架）
  const TILT_SELECTOR = '.grid.plugins > .card.item, .grid.market > .card.item, .board:not(.editing) [data-part~="widget.frame"] > .card'
  let tilted
  let tiltFrame = 0
  let tiltAt
  const settle = new Map()

  /**
   * 回正一张卡片；过渡走完再撤掉 transform，好让它的叠放层随之撤掉
   * @param {HTMLElement} card 卡片
   */
  const untilt = card => {
    card.dataset.pkTilt = "out"
    card.style.setProperty("--pk-rx", "0deg")
    card.style.setProperty("--pk-ry", "0deg")
    clearTimeout(settle.get(card))
    settle.set(card, setTimeout(() => {
      settle.delete(card)
      if (card.dataset.pkTilt !== "out") return
      delete card.dataset.pkTilt
      card.style.removeProperty("--pk-rx")
      card.style.removeProperty("--pk-ry")
    }, 450))
  }

  const onTiltMove = event => {
    if (event.pointerType !== "mouse") return
    const card = event.target instanceof Element ? event.target.closest(TILT_SELECTOR) : null
    if (card !== tilted) {
      if (tilted !== undefined) untilt(tilted)
      tilted = card ?? undefined
    }
    // 按着键（拖动、划选文字）时不跟
    if (tilted === undefined || event.buttons !== 0 || !lively()) return
    tiltAt = { x: event.clientX, y: event.clientY }
    if (tiltFrame !== 0) return
    tiltFrame = requestAnimationFrame(() => {
      tiltFrame = 0
      if (tilted === undefined || tiltAt === undefined) return
      const box = tilted.getBoundingClientRect()
      // 指针在卡片上的位置，-1 … 1；指到卡片外伸出来的菜单上时按边沿算
      const px = Math.max(-1, Math.min(1, ((tiltAt.x - box.left) / box.width) * 2 - 1))
      const py = Math.max(-1, Math.min(1, ((tiltAt.y - box.top) / box.height) * 2 - 1))
      // 大卡片倾得少：同样的角度在宽卡片边上位移大得多
      const max = Math.min(5, 1600 / Math.max(box.width, box.height))
      clearTimeout(settle.get(tilted))
      tilted.dataset.pkTilt = "in"
      tilted.style.setProperty("--pk-ry", `${(px * max).toFixed(2)}deg`)
      tilted.style.setProperty("--pk-rx", `${(-py * max).toFixed(2)}deg`)
    })
  }
  // 移出窗口时没有下一次 pointermove 来回正
  const onTiltOut = event => {
    if (event.relatedTarget === null && tilted !== undefined) {
      untilt(tilted)
      tilted = undefined
    }
  }
  document.addEventListener("pointermove", onTiltMove, { passive: true })
  document.addEventListener("pointerout", onTiltOut, { passive: true })
  cleanups.push(() => {
    document.removeEventListener("pointermove", onTiltMove)
    document.removeEventListener("pointerout", onTiltOut)
    if (tiltFrame !== 0) cancelAnimationFrame(tiltFrame)
    for (const timer of settle.values()) clearTimeout(timer)
    settle.clear()
    for (const card of document.querySelectorAll(".card[data-pk-tilt]")) {
      delete card.dataset.pkTilt
      card.style.removeProperty("--pk-rx")
      card.style.removeProperty("--pk-ry")
    }
  })

  return () => {
    for (const fn of cleanups.reverse()) fn()
  }
}
