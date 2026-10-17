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
import AppIcon from "../components/AppIcon.vue"
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

/** 跟在大字后的分母；快照未到或本块没有分母时为空串 */
const total = computed(() => {
  const now = snapshot.value
  const item = def.value
  return now === undefined || item?.total === undefined ? "" : item.total(now)
})

/** 大字是否转错误色 */
const bad = computed(() => {
  const now = snapshot.value
  const item = def.value
  return now !== undefined && item?.bad?.(now) === true
})
</script>

<template>
  <!-- 小字在上、大字在下：一排六块要读的是数，说明只是给数定性 -->
  <div class="card stat" :class="{ bad }">
    <span class="stat-label">{{ label }}</span>
    <span class="stat-value">
      <b>{{ text }}</b><small v-if="total !== ''">{{ total }}</small>
    </span>
    <AppIcon v-if="def?.icon" class="stat-ico" :path="def.icon" />
  </div>
</template>
