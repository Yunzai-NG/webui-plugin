<script setup lang="ts">
/**
 * 模块职责：市场类页面首次读索引时的骨架卡片
 * 依赖方向：无依赖；样式取 styles.css 的 `.skeleton` / `.skeleton-card` / `.grid.market`
 * 生命周期：随调用处的加载态挂卸
 * 注意事项：插件市场与面板商店共用这一份 —— 两页在使用者眼里是同一种页面，各写一份迟早长得不一样。
 */
withDefaults(
  defineProps<{
    /** 摆几块 */
    count?: number
  }>(),
  { count: 6 }
)
</script>

<template>
  <div class="grid market" aria-hidden="true">
    <div v-for="n in count" :key="n" class="card item skeleton-card">
      <div class="skeleton" style="height: 20px; width: 55%"></div>
      <div class="skeleton" style="height: 13px; width: 35%"></div>
      <div class="skeleton" style="height: 13px; width: 100%"></div>
      <div class="skeleton" style="height: 13px; width: 80%"></div>
      <div class="skeleton" style="margin-top: auto; height: 32px; width: 60%"></div>
    </div>
  </div>
</template>
