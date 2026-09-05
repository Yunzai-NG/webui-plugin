<script setup lang="ts">
/**
 * 模块职责：概览页的一个计数块 —— 大字取值 + 小字说明
 * 依赖方向：依赖 stats（取值与文案）与 context（页面注入的快照）
 * 生命周期：随所在格子
 * 注意事项：**同一个组件注册六次，以 `stat` prop 区分** —— 这也是注册表 `props` 字段的由来。
 *
 *          快照未到达时显示破折号而非 0：0 会被读成「确实是零个」。
 */
import { computed, inject } from "vue"
import { OVERVIEW } from "./context.js"
import { STATS } from "./stats.js"

const props = defineProps<{
  /** 要显示哪一个计数块，取 `STATS` 中的 id */
  stat: string
}>()

const data = inject(OVERVIEW, undefined)

/** 该计数块的定义；标识不存在时为 undefined */
const def = computed(() => STATS.find(item => item.id === props.stat))

/** 当前快照 */
const snapshot = computed(() => data?.value)

/** 大字 */
const text = computed(() => {
  const now = snapshot.value
  const item = def.value
  return now === undefined || item === undefined ? "—" : item.value(now)
})

/** 小字 */
const label = computed(() => {
  const now = snapshot.value
  const item = def.value
  if (item === undefined) return props.stat
  return now === undefined ? item.title : (item.label?.(now) ?? item.title)
})

/** 大字是否转错误色 */
const bad = computed(() => {
  const now = snapshot.value
  const item = def.value
  return now !== undefined && item?.bad?.(now) === true
})
</script>

<template>
  <div class="card stat">
    <h2 style="margin-top: 0; margin-bottom: var(--s2)">{{ label }}</h2>
    <b :class="bad ? 'tag err' : ''">{{ text }}</b>
  </div>
</template>
