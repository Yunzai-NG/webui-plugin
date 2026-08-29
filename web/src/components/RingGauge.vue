<script setup lang="ts">
/**
 * 模块职责：一枚环形进度 —— 环 + 环心的一行数值 + 环下的标题与小字
 * 依赖方向：依赖 gauge 的几何与档位；不认识任何数据来源
 * 生命周期：随所在组件
 * 注意事项：**本组件不是一张卡片** —— 显卡组件里会并排放好几枚环，各自成卡片就出现卡中卡。
 *          卡片由用它的那个组件提供。
 *
 *          **环自 12 点起画，顺时针**：SVG 的圆自 3 点起，故整体逆时针旋转 90°。用 `transform`
 *          而非 `d` 里写弧 —— `stroke-dasharray` 只认路径长度，手写弧的长度随半径变，
 *          改一次半径要重算两处。
 *
 *          **端帽取 butt，不取 round**：round 让弧两端各多出半个线宽，于是「快满」时两端叠在
 *          一处，看起来像已经绕过了一整圈。
 *
 *          图形整体 `aria-hidden`，数值另以文字给出 —— 读屏器念不出一段弧，而环心的百分数
 *          与环下的标题合起来已是完整的一句话。
 */
import { computed } from "vue"
import { RING_RADIUS, RING_VIEWBOX, gaugeLevel, percent, ringDash } from "../gauge.js"

const props = defineProps<{
  /** 比例（0-1）；undefined 意为测不到，此时环为空、环心为破折号 */
  ratio: number | undefined
  /** 环下方的标题 */
  title: string
  /** 环心的文本，缺省取百分数 */
  text?: string
  /** 标题下方的一行小字 */
  hint?: string
}>()

/** 环心文本 */
const center = computed(() => props.text ?? percent(props.ratio))

/** 着色档位 */
const level = computed(() => gaugeLevel(props.ratio))

/** 环的中心坐标 */
const mid = RING_VIEWBOX / 2
</script>

<template>
  <div class="gauge">
    <div class="ring-wrap">
      <svg
        class="ring"
        :viewBox="`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`"
        aria-hidden="true"
        focusable="false"
      >
        <circle class="ring-base" :cx="mid" :cy="mid" :r="RING_RADIUS" />
        <circle
          class="ring-fill"
          :class="level"
          :cx="mid"
          :cy="mid"
          :r="RING_RADIUS"
          :stroke-dasharray="ringDash(ratio)"
          :transform="`rotate(-90 ${mid} ${mid})`"
        />
      </svg>
      <b class="ring-value" :class="level">{{ center }}</b>
    </div>
    <span class="gauge-title">{{ title }}</span>
    <span v-if="hint !== undefined && hint !== ''" class="gauge-hint">{{ hint }}</span>
  </div>
</template>
