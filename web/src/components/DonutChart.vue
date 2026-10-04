<script setup lang="ts">
/**
 * 模块职责：环形占比图 + 图例
 * 依赖方向：只依赖 vue
 * 生命周期：随调用方
 * 注意事项：各段颜色由 `--accent-hue` 逐段旋转色相得出，随外观页的强调色一起变；
 *          颜色走 style 而非 stroke 属性，属性值里的 var() 不被所有浏览器解析。
 *          超过 `MAX_SEGMENTS` 的项并为「其他」，该段不可点。
 */
import { computed, ref } from "vue"

/** 图中的一项 */
export interface DonutItem {
  /** 点击时回传的标识 */
  key: string
  /** 图例文案 */
  label: string
  /** 数值 */
  value: number
}

const props = withDefaults(
  defineProps<{
    /** 各项，按数值降序传入 */
    items: readonly DonutItem[]
    /** 环心标题 */
    title?: string
    /** 环心数值 */
    total?: string
  }>(),
  { title: "", total: "" }
)

const emit = defineEmits<{
  /** 点了某一项 */
  pick: [key: string]
}>()

/** 单独成段的项数上限 */
const MAX_SEGMENTS = 7
/** 「其他」一段的标识，不回传 */
const OTHER = "\u0000other"
const RADIUS = 52
const CIRC = 2 * Math.PI * RADIUS
/** 段与段之间的空隙 */
const GAP = 2

const hovered = ref<string | undefined>(undefined)

const segments = computed(() => {
  const head = props.items.slice(0, MAX_SEGMENTS)
  const rest = props.items.slice(MAX_SEGMENTS).reduce((n, item) => n + item.value, 0)
  const all = rest > 0 ? [...head, { key: OTHER, label: "其他", value: rest }] : head
  const sum = all.reduce((n, item) => n + item.value, 0)
  let at = 0
  return all.map((item, i) => {
    const ratio = sum === 0 ? 0 : item.value / sum
    const len = ratio * CIRC
    const seg = {
      ...item,
      ratio,
      dash: Math.max(0, len - (all.length > 1 ? GAP : 0)),
      offset: -at,
      color: item.key === OTHER ? "var(--border-strong)" : `hsl(calc(var(--accent-hue) + ${i * 47}) 72% 62%)`,
      delay: `${i * 70}ms`
    }
    at += len
    return seg
  })
})

/**
 * 点一项
 * @param key 标识
 */
function pick(key: string): void {
  if (key !== OTHER) emit("pick", key)
}
</script>

<template>
  <div class="donut">
    <div class="donut-ring">
      <svg viewBox="0 0 120 120" role="img" :aria-label="title">
        <circle class="donut-base" cx="60" cy="60" :r="RADIUS" />
        <circle
          v-for="seg in segments"
          :key="seg.key"
          class="donut-seg"
          :class="{ dim: hovered !== undefined && hovered !== seg.key }"
          cx="60"
          cy="60"
          :r="RADIUS"
          :stroke-dasharray="`${seg.dash} ${CIRC}`"
          :stroke-dashoffset="seg.offset"
          :style="{ stroke: seg.color, '--circ': `${CIRC}`, animationDelay: seg.delay }"
          @mouseenter="hovered = seg.key"
          @mouseleave="hovered = undefined"
          @click="pick(seg.key)"
        />
      </svg>
      <div class="donut-center">
        <b>{{ total }}</b>
        <span>{{ title }}</span>
      </div>
    </div>
    <ul class="donut-legend">
      <li
        v-for="seg in segments"
        :key="seg.key"
        :class="{ dim: hovered !== undefined && hovered !== seg.key }"
        @mouseenter="hovered = seg.key"
        @mouseleave="hovered = undefined"
      >
        <button class="donut-item" :disabled="seg.key === OTHER" @click="pick(seg.key)">
          <i :style="{ background: seg.color }"></i>
          <span class="mono donut-label">{{ seg.label }}</span>
          <span class="donut-num">{{ seg.value }} · {{ Math.round(seg.ratio * 100) }}%</span>
        </button>
      </li>
    </ul>
  </div>
</template>
