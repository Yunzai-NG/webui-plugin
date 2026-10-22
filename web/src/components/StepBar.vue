<script setup lang="ts">
/**
 * 模块职责：步骤条 —— 一串编号圆点与连线，标出「做到第几步了」
 * 依赖方向：无依赖
 * 生命周期：随调用方
 * 注意事项：只是指示，不可点 —— 能跳步的话，各步之间的校验就得在这里再写一遍。
 *          已完成、当前、未到三态除了颜色，还靠圆点里的勾与数字区分，不让颜色作唯一的信息载体。
 */
defineProps<{
  /** 各步的名字 */
  steps: readonly string[]
  /** 当前在第几步，从 0 起 */
  current: number
}>()
</script>

<template>
  <ol class="steps" data-part="steps" aria-label="步骤">
    <li
      v-for="(step, i) in steps"
      :key="step"
      class="step"
      :class="{ done: i < current, now: i === current }"
      :aria-current="i === current ? 'step' : undefined"
    >
      <span class="step-dot" aria-hidden="true">{{ i < current ? "✓" : i + 1 }}</span>
      <span class="step-label">{{ step }}</span>
    </li>
  </ol>
</template>
