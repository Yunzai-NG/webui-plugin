<script setup lang="ts">
/**
 * 模块职责：概览页的一枚环形进度块 —— CPU 或内存
 * 依赖方向：依赖 gauges（取值与文案）、RingGauge（画环）、context（页面注入的快照）
 * 生命周期：随所在格子
 * 注意事项：**同一个组件注册两次，以 `gauge` prop 区分**，理由同 `StatWidget.vue`。
 *
 *          快照未到达时比例为 undefined —— 环为空、环心为破折号，读起来是「还不知道」；
 *          画一个 0% 的环读起来是「确实空着」。
 */
import { computed, inject } from "vue"
import RingGauge from "../components/RingGauge.vue"
import { OVERVIEW } from "./context.js"
import { GAUGES } from "./gauges.js"

const props = defineProps<{
  /** 要显示哪一个环，取 `GAUGES` 中的 id */
  gauge: string
}>()

const data = inject(OVERVIEW, undefined)

/** 该环的定义；标识不存在时为 undefined */
const def = computed(() => GAUGES.find(item => item.id === props.gauge))

/** 当前快照 */
const snapshot = computed(() => data?.value)

/** 比例；快照未到达或标识不存在时 undefined */
const ratio = computed(() => {
  const now = snapshot.value
  const item = def.value
  return now === undefined || item === undefined ? undefined : item.ratio(now)
})

/** 环下方的标题 */
const title = computed(() => def.value?.title ?? props.gauge)

/** 标题下方的小字；快照未到达时不写 */
const hint = computed(() => {
  const now = snapshot.value
  const item = def.value
  return now === undefined || item === undefined ? "" : item.hint(now)
})
</script>

<template>
  <div class="card gauge-card">
    <RingGauge :ratio="ratio" :title="title" :hint="hint" />
  </div>
</template>
