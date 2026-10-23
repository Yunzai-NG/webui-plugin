/**
 * 模块职责：点在某块区域之外、或按下 Esc 时收起它 —— 自绘下拉、胶囊候选、插件的命令清单共用
 * 依赖方向：只依赖 vue
 * 生命周期：随调用的组件；卸载时自己摘掉监听
 * 注意事项：听 `pointerdown` 而不是 `click`：点击在抬起时才触发，按下去拖到区域外再抬起会被当成「点了里面」。
 *          两个监听都挂在捕获阶段：区域外某个元素 `stopPropagation` 之后这里照样收得到；Esc 也要先于所在
 *          抽屉（原生 `<dialog>`）处理 —— 展开着时 Esc 只收这一层，不连带关掉整个抽屉。
 */
import { onBeforeUnmount, onMounted, type Ref } from "vue"

/**
 * 点在 `el` 之外、或展开时按 Esc，就调 `close`
 * @param el 区域
 * @param close 收起
 * @param isOpen 此刻是否展开着；给了才接管 Esc
 */
export function onClickOutside(el: Ref<HTMLElement | undefined>, close: () => void, isOpen?: () => boolean): void {
  /**
   * 判一次点击
   * @param event 指针事件
   */
  const onPointer = (event: PointerEvent): void => {
    const box = el.value
    if (box === undefined) return
    if (event.target instanceof Node && box.contains(event.target)) return
    close()
  }
  /**
   * 判一次按键
   * @param event 键盘事件
   */
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || isOpen === undefined || !isOpen()) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  onMounted(() => {
    document.addEventListener("pointerdown", onPointer, true)
    document.addEventListener("keydown", onKey, true)
  })
  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", onPointer, true)
    document.removeEventListener("keydown", onKey, true)
  })
}
