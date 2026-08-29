<script setup lang="ts">
/**
 * 模块职责：把一段 path 数据渲染为单色线稿图标
 * 依赖方向：无依赖
 * 生命周期：随所在组件
 * 注意事项：**图标一律描边、一律 `currentColor`**，由所在语境的前景色决定颜色，故深浅两模式、
 *          选中态与折叠态都无须各写一套取值。
 *
 *          `fill: none` 与 round 端帽是这套图形的前提：`help` 的那一点写作零长度线段
 *          `M12 17.2h.01`，换成 butt 端帽会整点消失。
 *
 *          统一 `aria-hidden`：图标一律伴随文字出现，读屏器再念一遍纯属噪声。
 */
defineProps<{
  /** 24×24 网格上的 svg path 数据 */
  path: string
}>()
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="path" />
  </svg>
</template>
