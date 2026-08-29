<script setup lang="ts">
/**
 * 模块职责：渲染确认对话框，把使用者的选择结算回提问方
 * 依赖方向：依赖 confirm.ts 的模块状态；不认识任何具体页面
 * 生命周期：由 `App.vue` 挂一个实例，随外壳存活
 * 注意事项：**用原生 `<dialog>` 而非自绘浮层**：焦点锁在框内（Tab 不会跑到背后的页面上）、
 *          `Esc` 关闭、渲染在 top layer（侧栏的 40 与遮罩的 30 都压不住它）三件白送，
 *          自绘要逐条补回来，而焦点锁尤其容易写漏。
 *
 *          **只在 `close` 里结算取消**，不另行监听 `cancel`（`Esc` 走 `cancel`，它随后触发
 *          `close`）—— 两处都结算的话，点「取消」按钮会结算两次。**且 `cancel` 一律拦掉**：
 *          放任原生关闭则元素立刻消隐，离场动画播不出来。同理，`pending` 清空时不再主动
 *          `close()`：`<Transition>` 等过渡结束才卸载，而卸载一个仍处 `[open]` 的 dialog
 *          即隐含关闭。
 *
 *          初始焦点刻意落在**取消**上：这里的提问一律关乎破坏性操作，回车的默认落点应当是
 *          「什么都不做」。`<dialog>` 里的 autofocus 由浏览器挑第一个可聚焦元素，故显式 focus()。
 */
import { nextTick, ref, watch } from "vue"
import { pending, settleConfirm } from "../confirm.js"

const el = ref<HTMLDialogElement | undefined>(undefined)
const cancelButton = ref<HTMLButtonElement | undefined>(undefined)

// 提问到来时开。`showModal()` 必须在元素已挂进 DOM 之后调用，故等一个 tick ——
// v-if 的插入发生在本次更新的 DOM 阶段。结算之后什么都不做：见文件头
watch(pending, async request => {
  if (request === undefined) return
  await nextTick()
  const next = el.value
  if (next === undefined || next.open) return
  next.showModal()
  cancelButton.value?.focus()
})

/**
 * 点在对话框之外即取消
 *
 * 原生 `<dialog>` 不会因点击遮罩而关闭。判据是 `target` 恰为 dialog 元素本身 ——
 * 遮罩区域在事件模型里归属该元素，其内容都在子元素上。
 * @param event 鼠标事件
 */
function onClick(event: MouseEvent): void {
  if (event.target === el.value) settleConfirm(false)
}
</script>

<template>
  <Transition name="pop">
    <dialog
      v-if="pending"
      ref="el"
      class="modal"
      @cancel.prevent="settleConfirm(false)"
      @close="settleConfirm(false)"
      @click="onClick"
    >
      <h2>{{ pending.title }}</h2>
      <p>{{ pending.body }}</p>
      <ul v-if="pending.details && pending.details.length > 0" class="plain hint">
        <li v-for="line in pending.details" :key="line">{{ line }}</li>
      </ul>
      <div class="modal-actions">
        <button ref="cancelButton" @click="settleConfirm(false)">取消</button>
        <button :class="pending.danger === true ? 'danger solid' : 'primary'" @click="settleConfirm(true)">
          {{ pending.okText ?? "确认" }}
        </button>
      </div>
    </dialog>
  </Transition>
</template>
