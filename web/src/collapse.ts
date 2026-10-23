/**
 * 模块职责：「从 0 长到内容高度」的 `<Transition>` 钩子
 * 依赖方向：只碰传进来的那个元素，不认识任何组件
 * 生命周期：纯函数，随调用
 * 注意事项：**`height: auto` 无从插值，故纯 CSS 写不出这个过渡** —— 写了也是硬切。这三个钩子
 *          在过渡开始前把当次的真实高度写成内联样式，播完再抹掉。
 *
 *          抹掉是必须的：留着会把元素钉死在展开那一刻的高度，而这类面板的高度会变
 *          （筛选面板切页签换一份索引、子表单里的字段被 `showWhen` 显隐）。
 *
 *          **收起那一路量 `offsetHeight`，展开那一路量 `scrollHeight`。** 展开时元素刚插入
 *          文档、高度还是起始值 0，`offsetHeight` 读到的就是 0；收起时它正以真实高度铺着，
 *          两者都对，但取错了都表现为「过渡不播」。
 *
 *          配套的 `overflow: hidden`、内边距与描边宽度归零归样式表那一侧（`.expand-*`）：
 *          那几条是「收起时不许漏出来」，与量高度无关。
 */

/**
 * 展开：从 0 长到内容高度
 * @param el 要展开的元素
 */
export function onExpandEnter(el: Element): void {
  const box = el as HTMLElement
  box.style.height = "0px"
  // 读一次强制结算，否则同一帧内两次赋值会被合并成「一直是终值」，过渡整个不播
  void box.scrollHeight
  box.style.height = `${box.scrollHeight}px`
}

/**
 * 展开完成：把高度交还给内容
 * @param el 已展开的元素
 */
export function onExpandDone(el: Element): void {
  ;(el as HTMLElement).style.height = ""
}

/**
 * 收起：从当前高度回到 0
 * @param el 要收起的元素
 */
export function onExpandLeave(el: Element): void {
  const box = el as HTMLElement
  box.style.height = `${box.offsetHeight}px`
  void box.scrollHeight
  box.style.height = "0px"
}

/**
 * 三个钩子的现成一束，供 `<Transition v-on="collapseHooks">`
 *
 * **成束给出而不是让调用方各绑一个**：三者缺一不可 —— 漏了 `afterEnter` 元素就钉死在
 * 展开那一刻的高度，漏了 `leave` 收起整个不播。而这两种漏法都不报错，只是观感不对。
 * 逐个绑的写法允许「绑了两个」，成束则不允许。
 */
export const collapseHooks = {
  enter: onExpandEnter,
  afterEnter: onExpandDone,
  leave: onExpandLeave
} as const

/**
 * `mode="out-in"` 换内容时让外框的高度跟着过渡：旧的离场前记下高度，新的入场时从那个高度长到自己的
 *
 * 钩子挂在 `<Transition>` 上，作用于它的父元素 —— 换的是里面那一块，变高矮的是外面那一圈。
 */
export function swapHeightHooks(): { beforeLeave: (el: Element) => void; enter: (el: Element) => void; afterEnter: (el: Element) => void } {
  let from = 0
  return {
    beforeLeave(el) {
      const box = el.parentElement
      if (box === null) return
      from = box.offsetHeight
      box.style.height = `${from}px`
    },
    enter(el) {
      const box = el.parentElement
      if (box === null || from === 0) return
      box.style.height = "auto"
      const to = box.offsetHeight
      box.style.height = `${from}px`
      void box.offsetHeight
      box.classList.add("swap-box")
      box.style.height = `${to}px`
    },
    afterEnter(el) {
      const box = el.parentElement
      if (box === null) return
      box.style.height = ""
      box.classList.remove("swap-box")
      from = 0
    }
  }
}

/** 每个外框上一次 `tweenHeight` 挂的收尾，再来一次时先摘掉 */
const tweening = new WeakMap<HTMLElement, (e: TransitionEvent) => void>()

/**
 * 改动前后量一次外框高度，从旧值过渡到新值：给「展开全部」这类一下子多出几行的改动
 *
 * 收尾只认外框自己的 `height` 过渡：里面格子的 `transitionend` 也会冒上来。
 * @param box 外框；没有时只做改动
 * @param change 改动，须等到 DOM 更新完再返回
 */
export async function tweenHeight(box: HTMLElement | undefined, change: () => Promise<void>): Promise<void> {
  if (box === undefined) return change()
  const from = box.offsetHeight
  await change()
  const old = tweening.get(box)
  if (old !== undefined) box.removeEventListener("transitionend", old)
  box.style.height = "auto"
  const to = box.offsetHeight
  if (to === from) {
    box.style.height = ""
    box.classList.remove("swap-box")
    return
  }
  box.style.height = `${from}px`
  void box.offsetHeight
  box.classList.add("swap-box")
  box.style.height = `${to}px`
  const done = (e: TransitionEvent): void => {
    if (e.target !== box || e.propertyName !== "height") return
    box.removeEventListener("transitionend", done)
    tweening.delete(box)
    box.style.height = ""
    box.classList.remove("swap-box")
  }
  tweening.set(box, done)
  box.addEventListener("transitionend", done)
}

/**
 * 离场者脱离文档流之前钉在原位
 *
 * 配 `.pin-leave`（`position: absolute`）：只脱流不钉位的话它会跳到容器左上角再淡出；
 * 不脱流的话余下几枚要等它播完才挪，挪的那一下是硬跳。容器须是定位元素。
 * @param el 离场的元素
 */
export function pinLeaving(el: Element): void {
  const box = el as HTMLElement
  box.style.left = `${box.offsetLeft}px`
  box.style.top = `${box.offsetTop}px`
  box.style.width = `${box.offsetWidth}px`
}
