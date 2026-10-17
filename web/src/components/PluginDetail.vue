<script setup lang="ts">
/**
 * 模块职责：插件页的「查看」模态 —— 一个核心插件的基础信息，及它注册的命令、任务与中间件
 * 依赖方向：依赖 format / Modal / TabBar / types
 * 生命周期：随插件页；`name` 由空串变为插件名即打开，每次打开回到「基础信息」
 * 注意事项：三份清单由插件页在首次打开时拉取后整份传进来，此处只按插件名筛
 */
import { computed, ref, watch } from "vue"
import { statusClass, statusText } from "../format.js"
import Modal from "./Modal.vue"
import TabBar from "./TabBar.vue"
import type { CommandItem, MiddlewareItem, PluginItem, TaskItem } from "../types.js"

/** 四个标签 */
const TABS = [
  { id: "basic", label: "基础信息" },
  { id: "commands", label: "命令" },
  { id: "tasks", label: "任务" },
  { id: "middlewares", label: "中间件" }
] as const

/** 事件大类的中文说法；中间件清单里逐条列出适用范围 */
const KIND_LABEL: Record<string, string> = {
  message: "消息",
  notice: "通知",
  request: "请求",
  meta: "元事件"
}

const props = defineProps<{
  /** 正在查看的插件名；空串意为模态未开 */
  name: string
  /** 全部插件 */
  plugins: readonly PluginItem[]
  /** 全部命令 */
  commands: readonly CommandItem[]
  /** 全部定时任务 */
  tasks: readonly TaskItem[]
  /** 全部中间件，顺序即执行顺序 */
  middlewares: readonly MiddlewareItem[]
}>()

const emit = defineEmits<{
  /** 使用者关闭了模态 */
  close: []
}>()

const tab = ref<(typeof TABS)[number]["id"]>("basic")
watch(
  () => props.name,
  name => {
    if (name !== "") tab.value = "basic"
  }
)

/** 正在查看的那个插件 */
const viewed = computed(() => props.plugins.find(p => p.name === props.name))

/** 它注册的命令 */
const viewedCommands = computed(() => props.commands.filter(c => c.plugin === props.name))

/** 它注册的定时任务 */
const viewedTasks = computed(() => props.tasks.filter(t => t.plugin === props.name))

/** 它注册的中间件，顺序即执行顺序 */
const viewedMiddlewares = computed(() => props.middlewares.filter(m => m.plugin === props.name))
</script>

<template>
  <Modal :open="name !== ''" wide :title="`插件「${name}」`" :sub="viewed?.description" @close="emit('close')">
    <TabBar v-model="tab" :items="TABS" label="插件详情" />

    <template v-if="viewed">
      <dl v-if="tab === 'basic'" class="facts">
        <dt>版本</dt>
        <dd class="mono">{{ viewed.version }}</dd>
        <dt>状态</dt>
        <dd><span class="tag" :class="statusClass(viewed.status)">{{ statusText(viewed.status) }}</span></dd>
        <dt v-if="viewed.author">作者</dt>
        <dd v-if="viewed.author">{{ viewed.author }}</dd>
        <!-- 单文件插件没有自己的安装目录，`root` 是它所在的那个（可能与别的插件共用），给文件更准 -->
        <template v-if="viewed.file">
          <dt>文件</dt>
          <dd class="mono">{{ viewed.file }}</dd>
        </template>
        <template v-else>
          <dt>安装目录</dt>
          <dd class="mono">{{ viewed.root }}</dd>
        </template>
        <dt>加载耗时</dt>
        <dd>{{ viewed.loadCost }}ms</dd>
        <dt>配置文件</dt>
        <dd>{{ viewed.configured ? "已声明" : "未声明 —— 该插件没有可改的配置项" }}</dd>
        <dt v-if="viewed.homepage">仓库</dt>
        <dd v-if="viewed.homepage">
          <a :href="viewed.homepage" target="_blank" rel="noreferrer noopener">{{ viewed.homepage }}</a>
        </dd>
        <dt v-if="viewed.error">错误</dt>
        <dd v-if="viewed.error" class="err">{{ viewed.error }}</dd>
      </dl>

      <template v-if="tab === 'commands'">
        <ul v-if="viewedCommands.length > 0" class="plain">
          <li v-for="cmd in viewedCommands" :key="cmd.name">
            <span class="mono">{{ cmd.name }}</span>
            <span v-if="cmd.master" class="tag warn">仅主人</span>
            <span v-if="cmd.admin" class="tag warn">仅群管</span>
            <span v-if="cmd.disabled" class="tag err">已禁用</span>
            <span v-if="cmd.hidden" class="tag">隐藏</span>
            <span v-if="cmd.desc">{{ cmd.desc }}</span>
            <span v-if="cmd.patterns.length > 1" class="hint mono">触发：{{ cmd.patterns.join(" / ") }}</span>
            <span v-if="cmd.usage" class="hint mono">用法：{{ cmd.usage }}</span>
          </li>
        </ul>
        <p v-else class="hint">该插件未注册命令。</p>
      </template>

      <template v-if="tab === 'tasks'">
        <ul v-if="viewedTasks.length > 0" class="plain">
          <li v-for="t in viewedTasks" :key="t.name">
            <span>{{ t.name }}</span>
            <span class="hint mono">{{ t.schedule }}</span>
            <span class="tag" :class="t.running ? 'warn' : ''">{{ t.running ? "执行中" : "空闲" }}</span>
            <span v-if="t.skipped > 0" class="tag warn">跳过 {{ t.skipped }} 次</span>
          </li>
        </ul>
        <p v-else class="hint">该插件未注册定时任务。</p>
      </template>

      <template v-if="tab === 'middlewares'">
        <ul v-if="viewedMiddlewares.length > 0" class="plain">
          <li v-for="(m, i) in viewedMiddlewares" :key="`${m.priority}:${i}`">
            <span class="hint mono">优先级 {{ m.priority }}</span>
            <span>{{ m.kinds.map(k => KIND_LABEL[k] ?? k).join(" / ") }}</span>
          </li>
        </ul>
        <p v-else class="hint">该插件未注册中间件。</p>
        <p class="hint">
          中间件没有名字（注册时只给函数），故此处以优先级与适用范围标识。数值小者靠外层，
          即更早拿到事件。全部插件的中间件顺序见下方说明。
        </p>
      </template>
    </template>
  </Modal>
</template>
