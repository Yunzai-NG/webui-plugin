<script setup lang="ts">
/**
 * 模块职责：数字从旧值滚动到新值
 * 依赖方向：只依赖 vue 与 appearance 的动效档位
 * 生命周期：随调用方；卸载时取消未完成的动画帧
 * 注意事项：系统要求减少动效、或外观页关闭动效时直接显示终值。
 */
import { onBeforeUnmount, ref, watch } from "vue"
import { motionEnabled } from "../appearance.js"

const props = defineProps<{
  /** 目标值 */
  value: number
}>()

/** 滚动时长 */
const DURATION = 700

const shown = ref(0)
let frame = 0

watch(
  () => props.value,
  (to, from) => {
    cancelAnimationFrame(frame)
    if (!motionEnabled()) {
      shown.value = to
      return
    }
    const start = from ?? 0
    const begin = performance.now()
    const step = (t: number): void => {
      const p = Math.min(1, (t - begin) / DURATION)
      // 末端减速，与 `--ease-settle` 观感一致
      shown.value = Math.round(start + (to - start) * (1 - Math.pow(1 - p, 3)))
      if (p < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  },
  { immediate: true }
)

onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <span class="count-up">{{ shown.toLocaleString("zh-CN") }}</span>
</template>
