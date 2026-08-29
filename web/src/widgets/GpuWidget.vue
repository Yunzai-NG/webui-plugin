<script setup lang="ts">
/**
 * 模块职责：概览页的显卡组件 —— 每块卡一枚环形进度
 * 依赖方向：依赖 RingGauge（画环）、format（字节）、context（页面注入的快照）
 * 生命周期：随所在格子
 * 注意事项：**本组件默认不在板上**（注册时声明 `defaultHidden`）：多数机器上没有 nvidia-smi
 *          （AMD、Intel、Termux 一概没有），默认摆上去等于给多数人一格永远测不到的东西。
 *
 *          **使用者自己添加之后仍测不到时写明「测不到」，不显示 0%** —— 0% 会被读成「显卡空闲」。
 *
 *          占用率一列 nvidia-smi 在虚拟化环境下给 `[N/A]`，内核据此不返回 `load`，于是环为空、
 *          环心为破折号，而显存那一行仍照常显示 —— 测不到占用率不意味着显存也测不到。
 */
import { computed, inject } from "vue"
import RingGauge from "../components/RingGauge.vue"
import { bytes } from "../format.js"
import { SYSTEM } from "./context.js"

const data = inject(SYSTEM, undefined)

/** 各显卡，附上算好的显存文案 */
const cards = computed(() => {
  const gpus = data?.value?.gpus
  if (gpus === undefined) return []
  return gpus.map((gpu, index) => ({
    key: `${index}:${gpu.name}`,
    name: gpu.name,
    ratio: gpu.load,
    hint:
      gpu.memoryUsed === undefined || gpu.memoryTotal === undefined
        ? ""
        : `显存 ${bytes(gpu.memoryUsed)} / ${bytes(gpu.memoryTotal)}`
  }))
})

/** 快照是否已到达 */
const loaded = computed(() => data?.value !== undefined)
</script>

<template>
  <div class="card fill">
    <h2 style="margin-top: 0">显卡</h2>
    <div v-if="cards.length > 0" class="gauge-row">
      <RingGauge
        v-for="card in cards"
        :key="card.key"
        :ratio="card.ratio"
        :title="card.name"
        :hint="card.hint"
      />
    </div>
    <p v-else class="sub">
      {{ loaded ? "测不到显卡 —— 本机没有 nvidia-smi，AMD 与 Intel 暂无跨平台的探测手段" : "加载中…" }}
    </p>
  </div>
</template>
