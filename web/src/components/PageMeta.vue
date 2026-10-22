<script setup lang="ts">
/**
 * 模块职责：页头下的一行元信息 —— 几枚「图标 + 数字 + 说明」，如「共 12 个 · 已加载 11 · 可更新 2」
 * 依赖方向：依赖 AppIcon
 * 生命周期：随调用方
 * 注意事项：只放事实，不放可点的东西（那是页头动作组的事）。数为 0 且标了 `hideZero` 的一项不出现：
 *          「可更新 0」是噪声。`tone` 只复述文案已说明的状态，不作唯一的信息载体。
 */
import AppIcon from "./AppIcon.vue"

/** 一项 */
export interface MetaItem {
  /** 24×24 网格上的 path 数据 */
  readonly icon: string
  /** 说明，如「已加载」 */
  readonly label: string
  /** 数字或短文本 */
  readonly value: string | number
  /** 语义色 */
  readonly tone?: "ok" | "warn" | "err"
  /** 为 0 时不显示 */
  readonly hideZero?: boolean
}

defineProps<{
  /** 各项，按顺序显示 */
  items: readonly MetaItem[]
}>()
</script>

<template>
  <div class="page-meta" data-part="page.meta">
    <template v-for="item in items" :key="item.label">
      <span v-if="!(item.hideZero && item.value === 0)" class="page-meta-item" :class="item.tone">
        <AppIcon class="page-meta-ico" :path="item.icon" />
        <b class="mono">{{ item.value }}</b>
        <span>{{ item.label }}</span>
      </span>
    </template>
  </div>
</template>
