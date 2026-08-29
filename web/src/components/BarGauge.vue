<script setup lang="ts">
/**
 * 模块职责：一条线性进度 —— 左端标签、右端数值、下方一条槽
 * 依赖方向：依赖 gauge 的档位与百分数；不认识任何数据来源
 * 生命周期：随所在组件
 * 注意事项：**用 div 加宽度百分比，不用 `<progress>`** —— 后者的槽与条由 `-webkit-progress-bar`
 *          一类的伪元素控制，按本站语义色着色得写三套厂商前缀；它换来的可访问性此处由
 *          `role="progressbar"` 与三个 aria 属性同样给到。
 *
 *          **宽度用百分比而非像素**：格子宽度随窗口变，写成像素就得在 JS 里监听尺寸变化。
 *
 *          比例取不到时（容量为 0 的挂载点）槽为空、数值为破折号，与「0% 已用」相区分
 *          （理由见 gauge.ts 文件头）。
 */
import { computed } from "vue"
import { gaugeLevel, percent } from "../gauge.js"

const props = defineProps<{
  /** 比例（0-1）；undefined 意为算不出，此时槽为空 */
  ratio: number | undefined
  /** 左端标签 */
  label: string
  /** 右端数值文案，缺省取百分数 */
  text?: string
}>()

/** 右端文案 */
const value = computed(() => props.text ?? percent(props.ratio))

/** 着色档位 */
const level = computed(() => gaugeLevel(props.ratio))

/** 槽内条的宽度 */
const width = computed(() => `${(props.ratio ?? 0) * 100}%`)

/** 给读屏器的整数百分数；测不到时不给 */
const now = computed(() => (props.ratio === undefined ? undefined : Math.round(props.ratio * 100)))
</script>

<template>
  <div class="bar">
    <div class="bar-head">
      <span class="bar-label mono">{{ label }}</span>
      <span class="bar-value" :class="level">{{ value }}</span>
    </div>
    <div
      class="bar-slot"
      role="progressbar"
      :aria-label="label"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="now"
      :aria-valuetext="value"
    >
      <div class="bar-fill" :class="level" :style="{ width }" />
    </div>
  </div>
</template>
