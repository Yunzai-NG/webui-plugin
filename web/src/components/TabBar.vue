<script setup lang="ts" generic="T extends string">
/**
 * 模块职责：横向页签条 —— `.toolbar.tabs` 的唯一写法
 * 依赖方向：依赖 AppIcon、tabscroll 的 `revealLeft` 与 appearance 的 `motionEnabled`
 * 生命周期：随调用方
 * 注意事项：键盘按 WAI-ARIA 页签模式：只有选中项可被 Tab 到，左右键 / Home / End 移动并选中。
 *          选中项一变就只横向滚动页签条把它露出来；`scrollIntoView` 会连带外层滚动容器。
 */
import { computed, onMounted, ref, watch } from "vue"
import AppIcon from "./AppIcon.vue"
import { motionEnabled } from "../appearance.js"
import { revealLeft } from "../tabscroll.js"

/** 一枚页签 */
export interface TabItem<K extends string = string> {
  /** 标识，即 v-model 的取值 */
  readonly id: K
  /** 文案 */
  readonly label: string
  /** 24×24 网格上的 path 数据 */
  readonly icon?: string
  /** 角标数字；undefined 时不画 */
  readonly count?: number
}

const props = defineProps<{
  /** 页签，顺序即显示顺序 */
  items: readonly TabItem<T>[]
  /** 选中项的标识 */
  modelValue: T
  /** 读屏器念出的页签条名称 */
  label?: string
}>()

const emit = defineEmits<{
  /** 选了某一枚（点已选中的那枚也发） */
  "update:modelValue": [id: T]
}>()

const bar = ref<HTMLElement>()

/** 选中项的下标；对不上任何一枚时 -1 */
const current = computed(() => props.items.findIndex(item => item.id === props.modelValue))

/** 可被 Tab 到的那一枚：选中项，对不上时取第一枚，免得整条键盘够不着 */
const focusable = computed(() => Math.max(0, current.value))

/**
 * 取第几枚页签的按钮
 * @param index 下标
 * @returns 按钮；不存在时 undefined
 */
function tabAt(index: number): HTMLElement | undefined {
  const el = bar.value?.children[index]
  return el instanceof HTMLElement ? el : undefined
}

/**
 * 把选中项滚进视野
 * @param smooth 是否平滑滚动；首次挂载时直接到位
 */
function reveal(smooth: boolean): void {
  const box = bar.value
  const tab = tabAt(current.value)
  if (box === undefined || tab === undefined) return
  // offsetLeft 以页签条为参照（样式表给了 position: relative），不受滚动与模态缩放影响
  const left = revealLeft(box, { left: tab.offsetLeft, width: tab.offsetWidth })
  if (left === undefined) return
  box.scrollTo({ left, behavior: smooth && motionEnabled() ? "smooth" : "auto" })
}

watch(
  () => props.modelValue,
  () => reveal(true),
  { flush: "post" }
)
onMounted(() => reveal(false))

/**
 * 方向键移动并选中
 * @param event 键盘事件
 */
function onKey(event: KeyboardEvent): void {
  const count = props.items.length
  if (count === 0) return
  const from = focusable.value
  let to: number
  switch (event.key) {
    case "ArrowRight":
      to = (from + 1) % count
      break
    case "ArrowLeft":
      to = (from - 1 + count) % count
      break
    case "Home":
      to = 0
      break
    case "End":
      to = count - 1
      break
    default:
      return
  }
  const item = props.items[to]
  if (item === undefined) return
  event.preventDefault()
  emit("update:modelValue", item.id)
  // 竖向不动，横向交给 reveal
  tabAt(to)?.focus({ preventScroll: true })
}
</script>

<template>
  <div ref="bar" class="toolbar tabs" role="tablist" :aria-label="label" @keydown="onKey">
    <button
      v-for="(item, i) in items"
      :key="item.id"
      type="button"
      role="tab"
      :aria-selected="i === current"
      :tabindex="i === focusable ? 0 : -1"
      :class="{ primary: i === current }"
      @click="emit('update:modelValue', item.id)"
    >
      <AppIcon v-if="item.icon" class="btn-ico" :path="item.icon" />{{ item.label }}
      <span v-if="item.count !== undefined" class="tag">{{ item.count }}</span>
      <slot :item="item" />
    </button>
  </div>
</template>
