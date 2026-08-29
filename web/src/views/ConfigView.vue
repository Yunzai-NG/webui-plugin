<script setup lang="ts">
/**
 * 模块职责：配置页 —— 编辑内核配置
 * 依赖方向：依赖 api / router / ConfigEditor / types
 * 生命周期：挂载时读取一次配置清单，用以判断内核配置是否存在
 * 注意事项：本页只管内核配置，插件配置的入口在插件页的模态里（上下文就在卡片上）。本页因此
 *          不再有「切换配置」这件事，那排分段标签一并删去。表单、保存与恢复默认值移入
 *          `ConfigEditor`，与插件页模态共用一份实现 —— 其中「补丁 vs 整份替换」是踩出来的，
 *          两处各写一份则下一次只会有一处被改对。
 *
 *          `#/config?name=<插件名>` 的旧深链只报一句并给出去插件页的链接：静默展示内核配置会让
 *          使用者以为自己在编辑那个插件的设置，进而把内核的项改错。
 */
import { computed, onMounted, ref, watch } from "vue"
import { get } from "../api.js"
import { errorText } from "../format.js"
import { currentQuery, hrefOf } from "../router.js"
import ConfigEditor from "../components/ConfigEditor.vue"
import PageHeader from "../components/PageHeader.vue"
import type { ConfigSummary } from "../types.js"

/** 内核配置名，与内核 `CORE_CONFIG_NAME` 一致（对应 `config/yunzai.yaml`） */
const CORE_NAME = "yunzai"

const list = ref<ConfigSummary[]>([])
const error = ref("")

/** 内核配置的摘要；内核尚未声明配置时为 undefined */
const core = computed(() => list.value.find(item => item.name === CORE_NAME))

/**
 * 哈希里指名的那份插件配置
 *
 * 只在它**不是**内核配置时有值 —— 此时来者走的是旧深链，本页已不再承载它。
 */
const redirected = ref("")

/** 读取配置清单，只为确认内核配置在不在 */
async function loadList(): Promise<void> {
  try {
    list.value = await get<ConfigSummary[]>("config")
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  }
}

/**
 * 记下哈希里指名的插件配置
 * @param name 查询参数里的配置名
 */
function noteTarget(name: string | undefined): void {
  redirected.value = name === undefined || name === CORE_NAME ? "" : name
}

onMounted(() => {
  noteTarget(currentQuery.value.name)
  void loadList()
})

// 已处于本页时，旧深链只改查询参数，组件不会重新挂载
watch(() => currentQuery.value.name, noteTarget)
</script>

<template>
  <div>
    <PageHeader route="config" sub="内核配置，表单由内核的 schema 声明自动生成" />

    <p v-if="error" class="banner">{{ error }}</p>

    <p v-if="redirected" class="banner warn">
      插件「{{ redirected }}」的配置已移至<a :href="hrefOf('plugins')">插件</a>页 ——
      在那张卡片上点「配置」即可就地编辑。本页只保留内核配置。
    </p>

    <ConfigEditor v-if="core" :name="CORE_NAME" />
    <p v-else-if="!error" class="hint">正在读取内核配置…</p>
  </div>
</template>
