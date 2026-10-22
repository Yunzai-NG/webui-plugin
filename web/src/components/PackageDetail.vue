<script setup lang="ts">
/**
 * 模块职责：插件页的包详情模态 —— 一个面板插件包的基础信息与它的组件
 * 依赖方向：依赖 panelconfig / registry / Modal / TabBar
 * 生命周期：随插件页；`pkg` 由空串变为包键即打开，每次打开回到「基础信息」
 * 注意事项：失败的组件与装上的列在同一张表里，不另设一节 —— 使用者找的是「我装的那枚组件在哪」
 */
import { computed, ref, watch } from "vue"
import { safeHref } from "../links.js"
import { panelConfigOf } from "../panelconfig.js"
import Modal from "./Modal.vue"
import TabBar from "./TabBar.vue"
import type { PanelPackageView } from "../registry.js"

/** 两个标签；面板插件包没有命令、任务与中间件 */
const TABS = [
  { id: "basic", label: "基础信息" },
  { id: "widgets", label: "组件" }
] as const

const props = defineProps<{
  /** 正在看的包键；空串意为模态未开 */
  pkg: string
  /** 已装的全部面板插件包 */
  packages: readonly PanelPackageView[]
}>()

const emit = defineEmits<{
  /** 使用者关闭了模态 */
  close: []
}>()

const tab = ref<(typeof TABS)[number]["id"]>("basic")
watch(
  () => props.pkg,
  key => {
    if (key !== "") tab.value = "basic"
  }
)

/** 正在看的那个包 */
const viewed = computed(() => props.packages.find(p => p.key === props.pkg))

/** 它在配置这件事上的状况；与配置无关的包为 undefined */
const config = computed(() => (viewed.value === undefined ? undefined : panelConfigOf(viewed.value.key)))
</script>

<template>
  <Modal
    :open="pkg !== ''"
    wide
    :title="`面板插件「${viewed?.name ?? ''}」`"
    :sub="viewed?.meta?.description"
    @close="emit('close')"
  >
    <TabBar v-model="tab" :items="TABS" label="面板插件详情" />

    <template v-if="viewed">
      <dl v-if="tab === 'basic'" class="facts">
        <dt>版本</dt>
        <dd class="mono">{{ viewed.meta?.version ?? "—" }}</dd>
        <dt>形态</dt>
        <dd>{{ viewed.kind === "multi" ? "多文件（一个目录，入口 index.js）" : "单文件（一个 .js）" }}</dd>
        <dt>作者</dt>
        <dd>{{ viewed.meta?.author ?? "—" }}</dd>
        <dt>组件</dt>
        <dd>
          {{ viewed.widgets.length }} 枚<span v-if="viewed.failures.length > 0" class="err">
            （其中 {{ viewed.failures.length }} 枚未装上）</span>
        </dd>
        <dt>本页页签</dt>
        <dd>{{ viewed.tabs.length === 0 ? "未贡献" : viewed.tabs.map(t => t.title).join("、") }}</dd>
        <dt>配置项</dt>
        <dd>
          <template v-if="config?.schema">
            {{ Object.keys(config.schema.properties ?? {}).length }} 项，可在卡片上点「配置」修改；
            值存在 <span class="mono">data/plugin/webui/panelconfig/{{ viewed.key }}.json</span>
          </template>
          <template v-else>未声明 —— 这个包没有可改的配置项</template>
        </dd>
        <!-- 声明写坏了或写错了地方都只表现为「配置按钮没出现」，这一行是它唯一的去处 -->
        <dt v-if="config?.problem">配置声明</dt>
        <dd v-if="config?.problem" class="err">{{ config.problem }}</dd>
        <dt>包键</dt>
        <dd class="mono">{{ viewed.key }}</dd>
        <dt v-if="viewed.meta?.repository">仓库</dt>
        <dd v-if="viewed.meta?.repository">
          <a v-if="safeHref(viewed.meta.repository)" :href="safeHref(viewed.meta.repository)" target="_blank" rel="noreferrer noopener">
            {{ viewed.meta.repository }}
          </a>
          <span v-else class="mono">{{ viewed.meta.repository }}</span>
        </dd>
      </dl>

      <template v-if="tab === 'widgets'">
        <table v-if="viewed.widgets.length > 0" class="rows panelrows">
          <thead>
            <tr>
              <th>组件</th>
              <th>标识</th>
              <th>所在页</th>
              <th>默认尺寸</th>
              <th>可调</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in viewed.widgets" :key="w.id">
              <td data-label="组件">
                {{ w.title }}
                <span v-if="w.failure" class="tag err">未装上</span>
              </td>
              <td data-label="标识" class="mono">{{ w.id }}</td>
              <td data-label="所在页">{{ w.page }}</td>
              <td data-label="默认尺寸" class="mono">{{ w.layout.w }} × {{ w.layout.fit ? "自适应" : w.layout.h }}</td>
              <td data-label="可调">{{ w.layout.resizable === true ? (w.layout.fit ? "宽度" : "宽高") : "固定" }}</td>
            </tr>
            <tr v-for="w in viewed.failures" :key="`${w.id}:why`">
              <td colspan="5" class="err">{{ w.title }}：{{ w.failure }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="hint">该包一枚组件都没有，只贡献了页签。</p>
      </template>
    </template>
  </Modal>
</template>
