<script setup lang="ts">
/**
 * 模块职责：概览页的磁盘组件 —— 每个分区一条线性进度
 * 依赖方向：依赖 BarGauge（画槽）、gauge（算比例）、format（字节）、context（页面注入的快照）
 * 生命周期：随所在格子
 * 注意事项：**分区数由内核给，本组件不猜也不截断**；装不下时格子自行滚动（见 styles.css 里
 *          `.board .card` 的 overflow）。由前端挑「显示哪几个」必然挑错 —— 使用者盯着的往往
 *          正是那个快满的移动硬盘。
 *
 *          **可用量取内核给的 `free`，不由 `total - used` 反推**：两者在 ext4 上不相等（内核取
 *          `bavail`，差额是为 root 预留的 5%），反推会让「剩 0」出现在实际还能写入的分区上。
 *
 *          一个分区都没探到时写明「探不到」，不留一格空白。
 */
import { computed, inject } from "vue"
import BarGauge from "../components/BarGauge.vue"
import { bytes } from "../format.js"
import { percent, ratioOf } from "../gauge.js"
import { SYSTEM } from "./context.js"

const data = inject(SYSTEM, undefined)

/** 各分区，附上算好的比例与右端文案 */
const rows = computed(() => {
  const disks = data?.value?.disks
  if (disks === undefined) return []
  return disks.map(disk => {
    const ratio = ratioOf(disk.used, disk.total)
    return {
      mount: disk.mount,
      ratio,
      text: `${percent(ratio)} · 剩 ${bytes(disk.free)} / ${bytes(disk.total)}`
    }
  })
})

/** 快照是否已到达 */
const loaded = computed(() => data?.value !== undefined)
</script>

<template>
  <div class="card fill">
    <h2 style="margin-top: 0">磁盘</h2>
    <div v-if="rows.length > 0" class="bars">
      <BarGauge v-for="row in rows" :key="row.mount" :ratio="row.ratio" :label="row.mount" :text="row.text" />
    </div>
    <p v-else class="sub">{{ loaded ? "探不到任何分区" : "加载中…" }}</p>
  </div>
</template>
