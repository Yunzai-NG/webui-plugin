<script setup lang="ts">
/**
 * 模块职责：自绘的单选下拉 —— 按钮显示当前项，点开就地展开一列选项
 * 依赖方向：依赖 outside.ts
 * 生命周期：随所在表单
 * 注意事项：原生 `<select>` 的展开层归系统画，跟不了主题，深色模式下是一块白底系统菜单。外观取配置表单那套下拉（`.cdd`），
 *          两处长得一样。
 *          键盘：上下键挪、回车或空格选、Esc 收起；点在外面也收起。
 */
import { computed, nextTick, ref } from "vue"
import { onClickOutside } from "../outside.js"

/** 一个选项 */
export interface PickOption {
  /** 值 */
  value: string
  /** 显示的字 */
  label: string
  /** 灰字补充 */
  note?: string
  /** 不可选 */
  disabled?: boolean
}

const props = defineProps<{
  /** 当前值 */
  modelValue: string
  /** 选项 */
  options: readonly PickOption[]
  /** 读屏用的名字 */
  label: string
  /** 关联 `<label for>` 的 id */
  id?: string
}>()

const emit = defineEmits<{
  /** 选了 */
  "update:modelValue": [value: string]
}>()

const root = ref<HTMLElement>()
const list = ref<HTMLElement>()
const open = ref(false)
/** 往上弹 */
const up = ref(false)
/** 展开层的高度上限，量出来的 */
const maxHeight = ref(280)
/** 键盘高亮的那一项 */
const cursor = ref(0)

const current = computed(() => props.options.find(o => o.value === props.modelValue))

onClickOutside(root, () => (open.value = false), () => open.value)

/**
 * 最近的会裁切的祖先（抽屉的内容区就是一个）；没有就是视口
 * @param el 起点
 * @returns 它的可见范围
 */
function clipOf(el: HTMLElement): { top: number; bottom: number } {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll|hidden)/.test(style.overflowY)) {
      const r = node.getBoundingClientRect()
      return { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}

/**
 * 展开并把高亮放到当前项上
 *
 * 往哪边弹按所在滚动区里的余量定：抽屉的内容区会裁掉越界的部分，只看视口的话，
 * 抽屉底部那个下拉的展开层会被切掉一截。两边都不够时取宽的那边，并把高度压到放得下。
 */
async function show(): Promise<void> {
  open.value = true
  cursor.value = Math.max(0, props.options.findIndex(o => o.value === props.modelValue))
  const box = root.value
  if (box !== undefined) {
    const clip = clipOf(box)
    const r = box.getBoundingClientRect()
    const below = clip.bottom - r.bottom - 8
    const above = r.top - clip.top - 8
    const want = Math.min(280, props.options.length * 40 + 12)
    up.value = below < want && above > below
    maxHeight.value = Math.max(120, Math.min(280, up.value ? above : below))
  }
  await nextTick()
  list.value?.querySelector<HTMLElement>("button.hover")?.scrollIntoView({ block: "nearest" })
}

/**
 * 选一项
 * @param option 选项
 */
function pick(option: PickOption | undefined): void {
  if (option === undefined || option.disabled === true) return
  emit("update:modelValue", option.value)
  open.value = false
}

/**
 * 键盘
 * @param event 键盘事件
 */
function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    // 展开着时 Esc 只收下拉，不该连带关掉所在的抽屉
    if (open.value) {
      event.preventDefault()
      event.stopPropagation()
    }
    open.value = false
    return
  }
  if (!open.value && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
    event.preventDefault()
    void show()
    return
  }
  if (!open.value) return
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault()
    const step = event.key === "ArrowDown" ? 1 : -1
    cursor.value = (cursor.value + step + props.options.length) % props.options.length
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    pick(props.options[cursor.value])
  }
}
</script>

<template>
  <div ref="root" class="cdd pick" :class="{ open, 'flip-up': up }">
    <button
      :id="id"
      type="button"
      class="cdd-trigger"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="`${label}：${current?.label ?? '未选'}`"
      @click="open ? (open = false) : void show()"
      @keydown="onKey"
    >
      <span class="cdd-value">{{ current?.label ?? "未选" }}<small v-if="current?.note" class="hint pick-note">{{ current.note }}</small></span>
      <svg class="cdd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
    <Transition name="cdd-fx">
      <div v-if="open" ref="list" class="cdd-menu" role="listbox" :aria-label="label" :style="{ maxHeight: `${maxHeight}px` }" @keydown="onKey">
        <button
          v-for="(o, i) in options"
          :key="o.value"
          type="button"
          role="option"
          :aria-selected="o.value === modelValue"
          :disabled="o.disabled === true"
          :class="{ hover: i === cursor, active: o.value === modelValue }"
          @pointerenter="cursor = i"
          @click="pick(o)"
        >
          {{ o.label }}<small v-if="o.note" class="hint pick-note">{{ o.note }}</small>
        </button>
      </div>
    </Transition>
  </div>
</template>