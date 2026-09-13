<script setup lang="ts">
/** 自定义页面图标：emoji 原样显示，图片仅接受服务端生成的受限数据 URL。 */
import { computed, ref, watch } from "vue"

const props = defineProps<{
  /** 服务端返回的 emoji 或图片数据 URL */
  icon?: string
}>()
const failed = ref(false)
const image = computed(() =>
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|avif);base64,[A-Za-z0-9+/=]+$/.test(props.icon ?? ""))
watch(() => props.icon, () => { failed.value = false })
</script>

<template>
  <span class="custom-page-icon" aria-hidden="true">
    <img v-if="image && !failed" :src="icon" alt="" @error="failed = true" />
    <span v-else>{{ image ? "📄" : icon || "📄" }}</span>
  </span>
</template>

<style scoped>
.custom-page-icon {
  display: inline-grid;
  place-items: center;
  flex: none;
  line-height: 1;
}
.custom-page-icon img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>