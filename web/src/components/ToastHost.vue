<script setup lang="ts">
/**
 * 模块职责：渲染全站的成功回执，摆在页面顶端居中，逐条自行收起
 * 依赖方向：依赖 toast.ts 的模块状态与 ToastItem；不认识任何具体页面
 * 生命周期：由 `App.vue` 挂一个实例，随整页存活
 * 注意事项：**整摞回执进 top layer（`popover="manual"`），为的是压住原生 `<dialog>`。** 配置表单
 *          开在模态里，它那条「已保存并立即生效」若留在普通层，会被 dialog 的 `::backdrop`
 *          压暗一层 —— 而那正是最要紧的一条回执。top layer 之内没有 `z-index` 可争，先后
 *          顺序由进入次序定，本组件在 `App.vue` 里挂在 `ConfirmDialog` 之后，故在它之上。
 *
 *          代价是**模态开着时这摞条子是 inert 的**：关闭钮点不动、悬停也不暂停（规范把
 *          「非模态 top layer 元素」一并算作被模态挡住，见 whatwg/html#11195）。可接受 ——
 *          计时在 `ToastItem` 自己手里，到点照样收起，不会卡在屏幕上。
 *
 *          **`showPopover()` 不可省**：带 `popover` 属性的元素在未打开时被 UA 置为
 *          `display: none`。不支持 popover 的浏览器会忽略该属性，于是元素照常显示 ——
 *          故定位一律由 `.toast-host` 自己写死（`position: fixed` 等），不借 popover 的
 *          UA 默认版面。两条路都落在同一个位置上。
 *
 *          `aria-live="polite"` 挂在常驻的外壳上而非逐条上：读屏器只对**已在无障碍树里**
 *          的活动区域播报后续插入，容器与内容同时出现时那一条往往不播。
 *
 *          **外壳随整页常驻，不以 `v-if` 跟着条数开合。** 一摞只剩一条时，`v-if` 会连
 *          `<TransitionGroup>` 一起拆掉，那条正在离场的来不及播完就没了；首条也因与容器同时
 *          首次渲染而不播入场（`<TransitionGroup>` 默认不为首渲染的子节点播入场）。两头都是
 *          硬切 —— 而单条回执恰是最常见的一种。故外壳常驻，只拿 popover 的开合管显隐。
 */
import { onMounted, ref, watch } from "vue"
import { dismissToast, toasts } from "../toast.js"
import ToastItem from "./ToastItem.vue"

const el = ref<HTMLDivElement | undefined>(undefined)

/** 浏览器认不认 popover；不认时整段开合都跳过，元素照常显示 */
const supported = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype

// 两处 try/catch：元素刚被移出 DOM、或已处于目标状态时，这两个方法会抛
/** 开合 popover；`on` 为真则开 */
function toggle(on: boolean): void {
  if (!supported) return
  try {
    if (on) el.value?.showPopover()
    else el.value?.hidePopover()
  } catch {
    // 已处于目标状态，无须处理
  }
}

// 第一条进场前先开：带 `popover` 的元素未打开时被 UA 置为 `display: none`，不开则入场过渡
// 无从播起。侦听器默认 pre 刷新，在本次渲染**之前**跑完，故那一条插进来时外壳已经显示
watch(
  () => toasts.value.length,
  count => {
    if (count > 0) toggle(true)
  }
)

// 外壳挂在 `App.vue` 的末尾，若在它之前完成 setup 的视图已经提示过一条，上面那个侦听器不会
// 为「挂载时就在场」的那条触发
onMounted(() => {
  if (toasts.value.length > 0) toggle(true)
})

/**
 * 最后一条离场播完才关
 *
 * **不能在条数归零时就关**：`display: none` 会把正在播的离场过渡掐断。`@after-leave` 逐条触发，
 * 故要再确认此刻一条不剩 —— 收起一摞里的中间那条也会走到这里。
 */
function onAfterLeave(): void {
  if (toasts.value.length === 0) toggle(false)
}
</script>

<template>
  <!--
    外壳常驻：`aria-live` 的区域须先在树里，后插入的内容才会被播报；且离场过渡要播完才能撤。

    `popover="manual"` 而非 `auto`：`auto` 那一档会因点击别处而自动关闭，且同时只允许一个
    —— 这摞条子不该被「点了页面另一处」收走，也不该与别人争那唯一的名额。

    `appear` 不可省：`<TransitionGroup>` 默认不为首渲染的子节点播入场，而外壳既已常驻，
    每一条都是「后插入的子节点」—— 除了浏览器刷新后紧接着弹的那一条，它赶上的是首渲染。
  -->
  <div
    ref="el"
    class="toast-host"
    popover="manual"
    role="status"
    aria-live="polite"
    aria-atomic="false"
  >
    <TransitionGroup name="toast" appear @after-leave="onAfterLeave">
      <ToastItem v-for="one in toasts" :key="one.id" :toast="one" @done="dismissToast(one.id)" />
    </TransitionGroup>
  </div>
</template>
