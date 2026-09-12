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
 *
 *          **`dismissible: false` 的提问没有关闭途径**：Esc 与点遮罩都不结算。那种提问卡在一个
 *          已经开始的动作中途（更新插件时发现本地有改动），关掉它不是「什么都没发生」，而是替
 *          使用者选了一个他没看清的分支。此时初始焦点也改落在**确认**上 —— 那一类的缺省是
 *          「暂存并继续」，即倒计时到点后会发生的事，两者须一致。
 *
 *          **倒计时归本组件而非提问方**：计时是呈现的一部分（要一秒一秒显示出来），而提问方
 *          只关心「答案是什么」。写在提问方就得让每个调用点各自维护一个 `setInterval`。
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue"
import { pending, settleConfirm } from "../confirm.js"

const el = ref<HTMLDialogElement | undefined>(undefined)
const cancelButton = ref<HTMLButtonElement | undefined>(undefined)
const okButton = ref<HTMLButtonElement | undefined>(undefined)

/** 剩余秒数；不倒计时的提问恒为 0 */
const left = ref(0)

/** 计时器句柄 */
let timer: ReturnType<typeof setInterval> | undefined

/** 这一问能否用 Esc 或点遮罩关掉 */
const dismissible = computed(() => pending.value?.dismissible !== false)

/** 停掉计时器。结算与卸载两处都要，故抽出来 */
function stopTimer(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
}

/**
 * 结算并停表
 *
 * 每一处结算都必须停表，否则上一问的计时器会把下一问按自己的缺省答掉 —— 而那个下一问
 * 可能是一个删除确认。
 * @param ok 是否确认
 */
function settle(ok: boolean): void {
  stopTimer()
  left.value = 0
  settleConfirm(ok)
}

// 提问到来时开。`showModal()` 必须在元素已挂进 DOM 之后调用，故等一个 tick ——
// v-if 的插入发生在本次更新的 DOM 阶段。结算之后只停表：关闭由 <Transition> 的卸载隐含完成
watch(pending, async request => {
  stopTimer()
  if (request === undefined) {
    left.value = 0
    return
  }
  await nextTick()
  const next = el.value
  if (next === undefined || next.open) return
  next.showModal()
  // 不可关闭的那一类缺省是「确认」（即倒计时到点会发生的事），故焦点落在确认上；
  // 其余一律落在取消上 —— 那些提问关乎破坏性操作，回车不该是「动手」
  if (request.dismissible === false) okButton.value?.focus()
  else cancelButton.value?.focus()

  const seconds = request.countdown ?? 0
  if (seconds <= 0) return
  left.value = seconds
  timer = setInterval(() => {
    left.value -= 1
    if (left.value > 0) return
    // 到点按提问方指定的那一边结算，缺省确认
    settle(request.timeoutOk !== false)
  }, 1000)
})

// 组件随外壳存活，理论上不会卸载；仍要停表 —— 一个不会停的 setInterval 在热重载下
// 会累积，而症状是「对话框刚弹出就自己答了」
onUnmounted(stopTimer)

/**
 * 点在对话框之外即取消
 *
 * 原生 `<dialog>` 不会因点击遮罩而关闭。判据是 `target` 恰为 dialog 元素本身 ——
 * 遮罩区域在事件模型里归属该元素，其内容都在子元素上。
 * @param event 鼠标事件
 */
function onClick(event: MouseEvent): void {
  if (dismissible.value && event.target === el.value) settle(false)
}
</script>

<template>
  <Transition name="pop">
    <!--
      `cancel` 一律 `.prevent`：不可关闭的那一类连结算都不做（Esc 按下去什么都不发生），
      可关闭的那一类由本组件结算，好让离场动画播得出来。

      `close` 只在可关闭时结算 —— 不可关闭的提问若走到 close，那只能是 `<Transition>`
      卸载一个仍 `[open]` 的 dialog 所隐含的那一次，此时答案早已给出，再结算一遍会把
      紧接着的下一问按「取消」答掉。
    -->
    <dialog
      v-if="pending"
      ref="el"
      class="modal"
      @cancel.prevent="dismissible && settle(false)"
      @close="dismissible && settle(false)"
      @click="onClick"
    >
      <h2>{{ pending.title }}</h2>
      <p>{{ pending.body }}</p>
      <ul v-if="pending.details && pending.details.length > 0" class="plain hint">
        <li v-for="line in pending.details" :key="line">{{ line }}</li>
      </ul>
      <!--
        不可关闭时明写出来，否则使用者会去找那个不存在的关闭途径

        倒计时那句连着说：读到「10 秒后自动暂存并继续」才知道等下去会发生什么，
        而只显示一个数字则像是在催促。
      -->
      <p v-if="pending.dismissible === false" class="hint">
        这一问没有关闭途径：请选择其中一项<span v-if="left > 0">
          ，或等 {{ left }} 秒后按「{{ (pending.timeoutOk !== false ? pending.okText : pending.cancelText) ?? "确认" }}」处理</span
        >。
      </p>
      <div class="modal-actions">
        <button ref="cancelButton" @click="settle(false)">
          {{ pending.cancelText ?? "取消" }}<span v-if="left > 0 && pending.timeoutOk === false">（{{ left }}）</span>
        </button>
        <button
          ref="okButton"
          :class="pending.danger === true ? 'danger solid' : 'primary'"
          @click="settle(true)"
        >
          {{ pending.okText ?? "确认" }}<span v-if="left > 0 && pending.timeoutOk !== false"> （{{ left }}）</span>
        </button>
      </div>
    </dialog>
  </Transition>
</template>
