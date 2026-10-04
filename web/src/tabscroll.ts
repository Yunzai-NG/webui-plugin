/**
 * 模块职责：横向页签条的滚动 —— 滚轮转横滚，选中项滚进视野
 * 依赖方向：算量是纯函数（可在 node 下跑用例）；装监听只碰 `document`
 * 生命周期：`installTabScroll()` 由 main.ts 在挂载前调一次，此后一直生效
 * 注意事项：滚动条全站隐去、桌面鼠标只有竖滚轮，不接手的话溢出的页签够不着。
 *          监听用委托装在 document 上，新加的页签条无须各自补。
 *          滚到尽头就把事件交回页面，否则指针停在页签条上时整页滚不动。
 */

/** 页签条的选择器，与 styles.css 里那一处形制同名 */
export const TABS_SELECTOR = ".toolbar.tabs"

/** 两端渐隐盖片的宽度，与 styles.css 里 `.toolbar.tabs` 的 background-size 一致 */
export const TAB_FADE_PX = 28

/** 一个滚动容器的当前状况，只取算量要用的三个数 */
export interface ScrollBox {
  /** 内容总宽 */
  scrollWidth: number
  /** 可见宽 */
  clientWidth: number
  /** 已横向滚过多少 */
  scrollLeft: number
}

/** 一次滚轮的两个分量 */
export interface WheelDelta {
  /** 横向分量；触控板横扫与带横滚的鼠标才非零 */
  deltaX: number
  /** 竖向分量 */
  deltaY: number
}

/** 一枚页签在页签条滚动坐标里的位置 */
export interface TabSpan {
  /** 左缘 */
  left: number
  /** 宽度 */
  width: number
}

/**
 * 这一次滚轮该把页签条横向滚多少
 *
 * 不接手的四种情形：容器没溢出；横向分量占主导（触控板横扫由浏览器处理，再叠就是双倍速）；
 * 已到该方向的尽头；竖向分量为零。
 * @param box 容器当前状况
 * @param delta 滚轮的两个分量
 * @returns 要横向滚过的像素；不接手时 undefined
 */
export function wheelShift(box: ScrollBox, delta: WheelDelta): number | undefined {
  const room = box.scrollWidth - box.clientWidth
  if (room <= 0) return undefined
  if (Math.abs(delta.deltaX) >= Math.abs(delta.deltaY)) return undefined
  if (delta.deltaY === 0) return undefined

  // 尽头判定留 1px 容差：滚动位置在缩放页面下是小数，`=== room` 几乎永不成立
  if (delta.deltaY > 0 && box.scrollLeft >= room - 1) return undefined
  if (delta.deltaY < 0 && box.scrollLeft <= 1) return undefined

  return delta.deltaY
}

/**
 * 要让一枚页签完整露出、不压在两端渐隐下，页签条该滚到哪里
 *
 * 只算横向：`scrollIntoView` 即便给了 `block: "nearest"`，祖先里另有滚动容器时仍会带动它们。
 * @param box 页签条当前状况
 * @param tab 该页签的位置
 * @param fade 两端各让出的宽度
 * @returns 目标 scrollLeft；已完整可见、或夹到边界后无须移动时 undefined
 */
export function revealLeft(box: ScrollBox, tab: TabSpan, fade = TAB_FADE_PX): number | undefined {
  const start = box.scrollLeft + fade
  const end = box.scrollLeft + box.clientWidth - fade
  let next: number
  if (tab.left < start) next = tab.left - fade
  else if (tab.left + tab.width > end) next = tab.left + tab.width + fade - box.clientWidth
  else return undefined

  const max = Math.max(0, box.scrollWidth - box.clientWidth)
  const target = Math.min(max, Math.max(0, next))
  // 滚到两端时那一侧的渐隐不画（见 styles.css），夹到边界后不动即已可见
  return Math.abs(target - box.scrollLeft) < 1 ? undefined : target
}

/**
 * 装上滚轮转横滚
 *
 * `passive: false` 是必须的：被动监听里 `preventDefault()` 无效，页签条与页面会同时在滚。
 * @returns 卸掉监听的函数，供用例与热更新收尾
 */
export function installTabScroll(): () => void {
  /**
   * 一次滚轮
   * @param event 滚轮事件
   */
  const onWheel = (event: WheelEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const box = target.closest(TABS_SELECTOR)
    if (!(box instanceof HTMLElement)) return

    const shift = wheelShift(box, event)
    if (shift === undefined) return
    event.preventDefault()
    box.scrollLeft += shift
  }

  document.addEventListener("wheel", onWheel, { passive: false })
  return () => document.removeEventListener("wheel", onWheel)
}
