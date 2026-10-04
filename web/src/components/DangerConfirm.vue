<script setup lang="ts">
/**
 * 模块职责：危险操作的确认框 —— 须键入指定文字才能确认
 * 依赖方向：依赖 Modal
 * 生命周期：随调用方；每次打开时清空输入
 * 注意事项：确认按钮仅在输入与 `expected` 完全一致时可用。
 */
import { ref, watch } from "vue"
import Modal from "./Modal.vue"

const props = defineProps<{
  /** 是否打开 */
  open: boolean
  /** 标题 */
  title: string
  /** 说明，写明影响范围 */
  body: string
  /** 须键入的确认文字 */
  expected: string
  /** 额外警示，以警告条显示 */
  warning?: string
  /** 受影响的样例，逐行列出 */
  samples?: readonly string[]
  /** 确认按钮文案 */
  okText?: string
  /** 是否正在执行 */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** 取消 */
  close: []
  /** 已键入确认文字并确认 */
  confirm: []
}>()

const typed = ref("")

watch(
  () => props.open,
  open => {
    if (open) typed.value = ""
  }
)

/** 输入一致时确认 */
function submit(): void {
  if (typed.value === props.expected && props.busy !== true) emit("confirm")
}
</script>

<template>
  <Modal :open="open" :title="title" @close="emit('close')">
    <p>{{ body }}</p>
    <p v-if="warning" class="banner warn danger-warning">{{ warning }}</p>
    <template v-if="samples && samples.length > 0">
      <p class="hint">受影响的键（样例）：</p>
      <ul class="danger-list">
        <li v-for="(item, i) in samples" :key="i" class="mono">{{ item }}</li>
      </ul>
    </template>
    <div class="field danger-typed">
      <label for="dangerTyped">
        请输入 <code class="mono">{{ expected }}</code> 以确认
      </label>
      <input
        id="dangerTyped"
        v-model="typed"
        class="mono"
        autocomplete="off"
        spellcheck="false"
        @keyup.enter="submit()"
      />
    </div>
    <template #actions>
      <button @click="emit('close')">取消</button>
      <button class="danger solid" :disabled="typed !== expected || busy === true" @click="submit()">
        {{ okText ?? "确认删除" }}
      </button>
    </template>
  </Modal>
</template>
