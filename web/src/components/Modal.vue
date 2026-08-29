<script setup lang="ts">
/**
 * 模块职责：一个通用模态框 —— 由调用方以 `open` 控制开合，内容与动作皆由插槽给出
 * 依赖方向：只依赖 vue；不认识任何具体页面，也不认识任何模块级状态
 * 生命周期：随调用方
 * 注意事项：**与 `ConfirmDialog` / `PathPicker` 不同，本组件不是单例**：一个页面可能同时要「配置」
 *          与「查看」两个模态，且各自的内容属于那一页 —— 做成单例就得把那一页的模板搬进 App.vue。
 *
 *          原生 `<dialog>` 白送三件事：焦点锁在框内、`Esc` 关闭、渲染在 top layer（不与任何 `z-index`
 *          相争）。自绘要逐条补回来，焦点锁尤其容易写漏。
 *
 *          `v-if` 而非 `v-show`：否则关闭期间表单仍持有上次的取值，下一次打开会先闪一下别人的配置。
 *
 *          **离场动画要求两处反直觉的写法**：`cancel` 一律 `preventDefault()`、改由本组件往外报关闭
 *          （放任原生行为则浏览器当即 `close()`，dialog 随之退出 top layer，动画一帧也播不出来）；
 *          `open` 转假时**不再主动 `close()`**（`<Transition>` 等过渡结束才卸载，而卸载一个仍处
 *          `[open]` 的 dialog 即隐含关闭）。`@close` 留着兜底，多报一次对调用方是幂等的。
 */
import { nextTick, ref, watch } from "vue"

const props = defineProps<{
  /** 是否打开 */
  open: boolean
  /** 标题 */
  title: string
  /** 一行说明，置于标题之下 */
  sub?: string
  /** 是否用宽形制（表单与清单需要横向空间） */
  wide?: boolean
}>()

const emit = defineEmits<{
  /** 使用者关闭了模态（点遮罩、按 Esc、或点了关闭按钮） */
  close: []
}>()

const el = ref<HTMLDialogElement | undefined>(undefined)

// `showModal()` 必须在元素已挂进 DOM 之后调用，故等一个 tick —— v-if 的插入
// 发生在本次更新的 DOM 阶段。关闭一侧什么都不做：见文件头第 2 条
watch(
  () => props.open,
  async open => {
    if (!open) return
    await nextTick()
    const next = el.value
    if (next !== undefined && !next.open) next.showModal()
  },
  { immediate: true }
)

/**
 * 点在对话框之外即关闭
 *
 * 原生 `<dialog>` 不会因点击遮罩而关闭。判据是 `target` 恰为 dialog 元素本身 ——
 * 遮罩区域在事件模型里归属该元素，其内容都在子元素上。
 * @param event 鼠标事件
 */
function onClick(event: MouseEvent): void {
  if (event.target === el.value) emit("close")
}
</script>

<template>
  <Transition name="pop">
    <dialog
      v-if="open"
      ref="el"
      class="modal sheet"
      :class="{ wide: wide === true }"
      @cancel.prevent="emit('close')"
      @close="emit('close')"
      @click="onClick"
    >
      <header class="sheet-head">
        <div>
          <h2>{{ title }}</h2>
          <p v-if="sub !== undefined && sub !== ''" class="hint">{{ sub }}</p>
        </div>
        <button class="icon" aria-label="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="sheet-body">
        <slot />
      </div>

      <footer v-if="$slots.actions" class="modal-actions sheet-foot">
        <slot name="actions" />
      </footer>
    </dialog>
  </Transition>
</template>
