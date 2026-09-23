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
