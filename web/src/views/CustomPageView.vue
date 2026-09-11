<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { getAt } from "../api.js"
import { currentQuery } from "../router.js"

interface Page { id: string; title: string; url?: string; plugin: string; provider?: string }
const pages = ref<Page[]>([])
const page = computed(() => pages.value.find(item => item.id === currentQuery.value.name) ?? pages.value[0])
const frameUrl = computed(() => {
  if (!page.value?.url) return ""
  const url = new URL(page.value.url, window.location.origin)
  url.searchParams.set("__webBase", window.location.pathname.replace(/\/$/, ""))
  return url.toString()
})
onMounted(async () => {
  try { pages.value = (await getAt<{ pages: Page[] }>("/plugin/webui/custom-pages")).pages ?? [] } catch { pages.value = [] }
})
</script>
<template>
  <section class="view">
    <header class="page-header"><div><h1>{{ page?.title ?? "扩展页面" }}</h1><p v-if="page">由插件「{{ page.provider || page.plugin }}」提供</p></div></header>
    <div v-if="frameUrl" class="custom-frame"><iframe :src="frameUrl" title="自定义页面" /></div>
    <div v-else class="card"><p>没有已加载的自定义页面。</p></div>
  </section>
</template>
<style scoped>
.custom-frame { min-height: calc(100vh - 150px); overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); }
iframe { display: block; width: 100%; height: calc(100vh - 152px); border: 0; }
</style>