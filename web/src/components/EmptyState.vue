<script setup lang="ts">
/**
 * 模块职责：空状态 —— 图标、一句标题、一句说明与可选动作
 * 依赖方向：依赖 AppIcon
 * 生命周期：随调用方
 * 注意事项：图标外圈是装饰，`aria-hidden`；说明文字承担全部信息。
 */
import AppIcon from "./AppIcon.vue"

defineProps<{
  /** 24×24 网格上的 path 数据 */
  icon: string
  /** 标题 */
  title: string
  /** 说明 */
  hint?: string
}>()
</script>

<template>
  <div class="empty" data-part="empty">
    <span class="empty-art" data-part="empty.art" aria-hidden="true">
      <svg class="empty-orbit" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r="44" />
        <circle cx="48" cy="48" r="32" />
      </svg>
      <AppIcon class="empty-icon" :path="icon" />
    </span>
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <div v-if="$slots.default" class="row empty-actions"><slot /></div>
  </div>
</template>
