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
 *
 *          **`shapes` 与 `path` 并存，不合成一个 prop。** 面板自己那二十来枚图标都是一段 path，
 *          写成 `:path="..."` 最直接；而插件自报的图标可能含 `circle`、`rect` 一类元素，
 *          经服务端 `pageicon.ts` 抠成逐元素的几何数据后由 `shapes` 进来。两者都进同一个
 *          外壳，故上色（描边 + `currentColor`）对插件图标同样成立 —— 那正是它跟着深浅主题
 *          变色的原因：**几何归插件，颜色一概归这里**。
 */
import type { IconShape } from "../types.js"

defineProps<{
  /** 24×24 网格上的 svg path 数据；给了 `shapes` 时可省 */
  path?: string
  /** 逐元素的几何数据，插件自报的图标走这一路；与 `path` 二者其一 */
  shapes?: readonly IconShape[]
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
    <!--
      `shapes` 优先：两者都给时以逐元素的那份为准（调用方拿它当回落值传 `path` 也就成立了）。

      属性经 `v-bind` 原样铺开是安全的：键名与取值都已由服务端的白名单过过一遍，
      既不含 `on*` 也不含括号引号 —— 见 pageicon.ts 的 `SHAPES` 与 `GEOMETRY_RE`。
    -->
    <template v-if="shapes !== undefined && shapes.length > 0">
      <component :is="shape.tag" v-for="(shape, i) in shapes" :key="i" v-bind="shape.attrs" />
    </template>
    <path v-else-if="path !== undefined" :d="path" />
  </svg>
</template>
