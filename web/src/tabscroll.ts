/**
 * 模块职责：让横向页签条能被鼠标滚轮滚动，并把激活项带进视野
 * 依赖方向：算量那半是纯函数，不碰任何浏览器 API（故可在 node 环境下跑用例）；
 *          装监听那半只碰 `document`
 * 生命周期：`installTabScroll()` 由 main.ts 在挂载前调一次，此后一直生效
 * 注意事项：**页签条溢出时滑不动，是本模块要消灭的那个缺陷。** `.toolbar.tabs` 已是
 *          `overflow-x: auto`，程序上滚得动，但两条合起来让人滚不动：滚动条被全站隐去
 *          （见 styles.css 的「滚动条一律不显形」），故看不出还有内容；而桌面鼠标只有
 *          竖滚轮，横向容器不响应它。于是八个分区里第八个就此够不着 —— 那一栏的配置项
 *          等于不存在。
 *
 *          **用事件委托装在 document 上，不逐处给组件加监听。** `.toolbar.tabs` 现有七处
 *          （配置分区、帮助页、插件页两处模态与页级、面板商店、插件市场），逐处装等于
 *          日后每加一处都要记得补，而漏掉的那处表现为「这里的页签滑不动」——
 *          与此刻的缺陷一模一样。
 *
 *          **滚到尽头就把事件交回页面。** 不交的话，指针停在页签条上时整页都滚不动了：
 *          使用者会以为页面卡住，而他只是把鼠标放在了那一条上。
 */

/** 页签条的选择器，与 styles.css 里那一处形制同名 */
export const TABS_SELECTOR = ".toolbar.tabs"

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

/**
 * 这一次滚轮该把页签条横向滚多少
 *
 * 返回 undefined 意为**不接手**，调用方须放任浏览器照原样处理（页面照常竖滚）。四种情形
 * 不接手，每一种都有它必须存在的理由：
 *
 * - **容器没溢出**：一排页签全在眼前，横滚无从发生，接手只会让页面在这一条上滚不动。
 * - **横向分量已占主导**：触控板横扫由浏览器原生处理，再叠一次就是双倍速。
 * - **已到该方向的尽头**：滚到最右还接手，指针停在页签条上时整页都动不了。
 * - **竖向分量为零**：纯横扫或纯缩放，没有可换算的量。
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
 * 装上滚轮转横滚
 *
 * `passive: false` 是必须的：接手时要 `preventDefault()` 拦下页面的竖滚，而被动监听里
 * 那一句无效（浏览器只给一条控制台警告，症状是页签条与页面同时在滚）。
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

/**
 * 把某个页签滚进视野
 *
 * **为「自动跳到有错的那一栏」而设。** 那一栏可能正在溢出区里，跳过去却看不见它被选中，
 * 使用者看到的是「它说跳了，可高亮的还是刚才那个」。
 *
 * `block: "nearest"` 一并给上：默认的 `start` 会连带把整页竖向滚一段，把页签条顶到视口
 * 上沿 —— 而此处只想横向挪一点。
 * @param box 页签条元素；不在文档里时什么都不做
 * @param title 该页签的文案，按它在子元素里找
 */
export function revealTab(box: HTMLElement | undefined, title: string): void {
  if (box === undefined) return
  for (const item of box.children) {
    if (!(item instanceof HTMLElement)) continue
    if (item.textContent?.trim().startsWith(title) !== true) continue
    item.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" })
    return
  }
}
