<script setup lang="ts">
/**
 * 模块职责：导航图标 —— 当前主题换了这一枚就用主题的，否则用内置的线稿
 * 依赖方向：依赖 themes（当前主题的图标集）与 AppIcon
 * 生命周期：随所在组件
 * 注意事项：主题的图标有两种：描边线稿（`stroke`，仍按 `currentColor` 着色，选中态照旧变色）与
 *          彩色图片（`image`，原色显示 —— 选中态改由底色与左侧标记表达，见 styles.css 的 `.nav a.on`）。
 *          主题没给的那几枚退回内置，故一款只画了三枚图标的主题也能用。
 */
import { computed } from "vue"
import { navIcons } from "../themes.js"
import AppIcon from "./AppIcon.vue"

const props = defineProps<{
  /** 导航项 id，即 ROUTES 里的 id */
  route: string
  /** 内置的 path 数据 */
  path: string
}>()

const themed = computed(() => navIcons.value?.nav[props.route])
const isImage = computed(() => navIcons.value?.mode === "image" && themed.value !== undefined)
</script>

<template>
  <img v-if="isImage" class="theme-icon" :src="themed" alt="" aria-hidden="true" data-part="nav.icon" draggable="false" />
  <AppIcon v-else :path="themed ?? path" data-part="nav.icon" />
</template>
