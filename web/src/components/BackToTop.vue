<script setup lang="ts">
/**
 * 模块职责：回到顶部 —— 向下滚过 400px 才出现，外圈的环随滚动进度走满
 * 依赖方向：依赖 AppIcon 与 appearance 的 `motionEnabled`
 * 生命周期：随所在页面；App.vue 按路由给它 `:key`，换页即重新挂载、重新找滚动容器
 * 注意事项：**滚的不一定是窗口。** 宽屏下滚的是 `.main`（见 styles.css 的宽屏增强），窄屏下是文档本身。
 *          故挂载时看父元素会不会滚：会就监听它，不会就监听窗口 —— 写死任何一边，另一种宽度下按钮
 *          就永远不出现。
 */
import { onMounted, onUnmounted, ref } from "vue"
import AppIcon from "./AppIcon.vue"
import { motionEnabled } from "../appearance.js"

/** 滚过多少像素才出现 */
const SHOW_AFTER = 400
/** 进度环半径 */
const R = 20
/** 进度环周长 */
const LEN = 2 * Math.PI * R
/** 向上的箭头 */
const UP = "M12 19V5M6 11l6-6 6 6"

const el = ref<HTMLElement>()
const shown = ref(false)
const progress = ref(0)
let target: HTMLElement | Window = window
let frame = 0

/**
 * 当前的滚动位置与可滚的总量
 * @returns 位置与总量
 */
function metrics(): { y: number; max: number } {
  if (target instanceof Window) {
    return { y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight }
  }
  return { y: target.scrollTop, max: target.scrollHeight - target.clientHeight }
}

/** 量一次 */
function measure(): void {
  frame = 0
  const { y, max } = metrics()
  shown.value = y > SHOW_AFTER
  progress.value = max > 0 ? Math.min(1, y / max) : 0
}

/** 滚动时至多每帧量一次 */
function onScroll(): void {
  if (frame === 0) frame = requestAnimationFrame(measure)
}

/** 回到顶部 */
function toTop(): void {
  target.scrollTo({ top: 0, behavior: motionEnabled() ? "smooth" : "auto" })
}

onMounted(() => {
  const parent = el.value?.parentElement
  if (parent !== null && parent !== undefined && /auto|scroll/.test(getComputedStyle(parent).overflowY)) target = parent
  target.addEventListener("scroll", onScroll, { passive: true })
  measure()
})

onUnmounted(() => {
  target.removeEventListener("scroll", onScroll)
  if (frame !== 0) cancelAnimationFrame(frame)
})
</script>

<template>
  <button
    ref="el"
    type="button"
    class="to-top"
    :class="{ on: shown }"
    data-part="backtotop"
    aria-label="回到顶部"
    title="回到顶部"
    :tabindex="shown ? 0 : -1"
    @click="toTop"
  >
    <svg class="to-top-ring" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" :r="R" class="to-top-track" />
      <circle cx="24" cy="24" :r="R" class="to-top-bar" :stroke-dasharray="LEN" :stroke-dashoffset="LEN * (1 - progress)" />
    </svg>
    <AppIcon class="to-top-ico" :path="UP" />
  </button>
</template>
