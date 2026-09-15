<script setup lang="ts">
/**
 * 模块职责：帮助页 —— 命令速查与文档入口
 * 依赖方向：依赖 api / format / types
 * 生命周期：挂载时读取一次命令清单，此后仅在用户点击刷新时重新读取
 * 注意事项：**命令清单取自运行时注册表，而非文档** —— 文档说的是发行版的能力，进程里实际注册的取决于
 *          已加载的插件与启停操作，两者不一致时使用者要的是前者。
 *
 *          默认隐去 `hidden` 命令（多为插件内部的调试入口），但仍给一个开关：排查「命令无响应」时需要
 *          确认它到底注册上了没有。
 *
 *          **按插件分标签，不是一个插件一张卡片竖排下去**：插件多起来之后竖排要划很久，而此页最常用的
 *          动作恰是「看看某个插件带了哪些命令」。搜索作用于当前标签。
 *
 *          **本页与插件页的命令清单刻意并存**：插件页那份回答「这个插件带来了什么」，此处回答「这条命令
 *          是谁注册的」—— 后者在排查时是入口，而那时使用者并不知道它属于哪个插件。
 *
 *          文档链接指向站点而非本地文件：文档已独立成库、不随框架分发，且面板可能跑在无桌面环境的机器上。
 *          **标题须与文档站一致** —— 同一篇文档在两处叫两个名字时，使用者无从判断面板里的条目对应侧边栏
 *          的哪一项。
 */
import { computed, onMounted, ref } from "vue"
import { get } from "../api.js"
import { errorText } from "../format.js"
import PageHeader from "../components/PageHeader.vue"
import type { CommandItem } from "../types.js"

/** 文档站点地址，不含末尾斜杠 */
const DOCS_SITE = "https://yunzai-ng.github.io"

/** 文档条目 */
interface DocLink {
  /** 标题，须与文档站一致 */
  readonly title: string
  /** 说明 */
  readonly desc: string
  /** 站点路径，与文档站的文件名同名 */
  readonly path: string
}

/** 一组文档，分组与组内顺序均照文档站的侧边栏 */
interface DocGroup {
  /** 组名，与文档站侧边栏的分组标题一致 */
  readonly title: string
  /** 该组的条目 */
  readonly docs: readonly DocLink[]
}

/**
 * 文档入口
 *
 * **分组与顺序照抄文档站的侧边栏**（`docs/.vitepress/config.mts` 的 `sidebar`）：
 * 平铺一列时「官方插件」那七页会把另外十几条挤没，而使用者是按侧边栏的结构记路的。
 * 文档站加页时此处一并加 —— 两处不同步的表现是面板里查不到一篇已经存在的文档。
 */
const DOC_GROUPS: readonly DocGroup[] = [
  {
    title: "入门",
    docs: [
      { title: "快速开始", desc: "装 CLI、初始化目录、启动与打开面板", path: "getting-started" },
      { title: "CLI 命令", desc: "逐命令的作用、选项与注意事项", path: "cli" },
      { title: "从源码构建", desc: "改框架自身或跑在未发布的提交上", path: "from-source" },
      { title: "配置与面板", desc: "内核配置逐项说明，与本面板的配置页对应", path: "config" }
    ]
  },
  {
    title: "插件开发",
    docs: [
      { title: "上手", desc: "最小插件、目录与入口、definePlugin 与 ctx 全表", path: "plugin-api" },
      { title: "发消息", desc: "文本、图片、引用、转发、渲染出图与主动推送", path: "plugin/message" },
      { title: "命令与事件", desc: "命令声明、匹配语义、中间件与事件对象", path: "plugin/command" },
      { title: "配置与存储", desc: "配置 schema、KV、SQLite 与进程内缓存", path: "plugin/storage" },
      { title: "任务与协作", desc: "定时任务、插件间服务、HTTP 路由与生命周期", path: "plugin/service" },
      { title: "适配器开发", desc: "接一个聊天平台：事件翻译与 BotDriver 能力面", path: "adapter" },
      { title: "渲染与模板", desc: "出图：两种模板、渲染选项与自写渲染器", path: "renderer" },
      { title: "测试与发布", desc: "无内核测试命令，以及发布进插件市场", path: "plugin/publish" }
    ]
  },
  {
    title: "官方插件",
    docs: [
      { title: "一览与两个市场", desc: "官方插件有哪些、各自装在哪个市场", path: "official-plugins" },
      { title: "webui（面板）", desc: "本面板自身：十个页面、面板插件的宿主与商店", path: "plugins/webui" },
      { title: "adapter-napcat（QQ）", desc: "经 NapCat 接入 QQ 的适配器", path: "plugins/adapter-napcat" },
      { title: "adapter-qqbot（QQ 官方）", desc: "QQ 开放平台机器人：群、私聊与频道", path: "plugins/adapter-qqbot" },
      { title: "renderer-puppeteer（出图）", desc: "无头浏览器渲染器，模板转图片", path: "plugins/renderer-puppeteer" },
      { title: "hardware（硬件监控）", desc: "概览页的硬件组件与本包的 node 侧采样", path: "plugins/hardware" },
      { title: "webui-example（示例）", desc: "面板插件示例包，照抄它比从零拼快", path: "plugins/webui-example" },
      { title: "mhy-game（米游社）", desc: "米游社相关命令与签到", path: "plugins/mhy-game" }
    ]
  },
  {
    title: "扩展",
    docs: [
      { title: "面板插件", desc: "往面板加组件与页签：形态、配置、样式与商店", path: "panel-plugin" },
      { title: "扩展页面", desc: "插件在面板里挂一个自己的页面", path: "custom-page" },
      { title: "插件市场", desc: "索引文件格式、镜像与自建索引的方式", path: "market" }
    ]
  },
  {
    title: "参考",
    docs: [
      { title: "框架说明", desc: "分层约束、事件管线与各子系统职责", path: "architecture" },
      { title: "从 Miao-Yunzai 迁移", desc: "自旧版 Yunzai 迁移的差异与对应关系", path: "migration" },
      { title: "性能基线", desc: "内存与吞吐实测数据，以及低内存设备的调整项", path: "perf" }
    ]
  }
]

const commands = ref<CommandItem[]>([])
const error = ref("")
const loading = ref(false)
const keyword = ref("")
const showHidden = ref(false)
/** 当前标签：空串为「全部」，否则是插件名 */
const plugin = ref("")

/**
 * 全部注册过命令的插件名，升序
 *
 * 取自命令清单而非插件清单：没注册命令的插件在此页无内容可看，给它一个空标签
 * 只是让标签排更长。
 */
const pluginNames = computed(() => [...new Set(commands.value.map(cmd => cmd.plugin))].sort((a, b) => a.localeCompare(b)))

/** 每个插件各有几条命令，用于标签上的角标 */
const countByPlugin = computed(() => {
  const map = new Map<string, number>()
  for (const cmd of commands.value) {
    if (cmd.hidden && !showHidden.value) continue
    map.set(cmd.plugin, (map.get(cmd.plugin) ?? 0) + 1)
  }
  return map
})

/**
 * 按当前标签、关键词与隐藏开关过滤后的命令
 *
 * 标签先于关键词：切到某插件即只在该插件的命令里搜 —— 这正是标签存在的理由。
 */
const filtered = computed(() => {
  const word = keyword.value.trim().toLowerCase()
  return commands.value.filter(cmd => {
    if (cmd.hidden && !showHidden.value) return false
    if (plugin.value !== "" && cmd.plugin !== plugin.value) return false
    if (word === "") return true
    const haystack = [cmd.name, cmd.desc ?? "", cmd.usage ?? "", ...cmd.patterns].join(" ").toLowerCase()
    return haystack.includes(word)
  })
})

/**
 * 过滤结果按插件分组，插件名升序
 *
 * 「全部」标签下仍分组呈现（否则数百条命令连成一片读不出归属）；选定某插件时
 * 自然只余一组。
 */
const groups = computed(() => {
  const map = new Map<string, CommandItem[]>()
  for (const cmd of filtered.value) {
    const list = map.get(cmd.plugin)
    if (list) list.push(cmd)
    else map.set(cmd.plugin, [cmd])
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

/** 过滤后余下的命令总数 */
const shown = computed(() => filtered.value.length)

/** 读取命令清单 */
async function load(): Promise<void> {
  loading.value = true
  try {
    commands.value = await get<CommandItem[]>("commands")
    error.value = ""
    // 选中的插件可能在重载后不再注册命令，此时退回「全部」而不是留一个空标签
    if (plugin.value !== "" && !commands.value.some(cmd => cmd.plugin === plugin.value)) plugin.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <div>
    <PageHeader route="help" sub="当前进程已注册的命令，以及框架文档入口">
      <template #actions>
        <button :disabled="loading" @click="void load()">{{ loading ? "读取中…" : "刷新" }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="banner">{{ error }}</p>

    <div class="card">
      <h2>文档</h2>
      <!-- 分组照文档站的侧边栏：使用者按那个结构记路，见 DOC_GROUPS 的注释 -->
      <template v-for="group in DOC_GROUPS" :key="group.title">
        <h3>{{ group.title }}</h3>
        <ul class="plain">
          <li v-for="doc in group.docs" :key="doc.path">
            <a :href="`${DOCS_SITE}/${doc.path}`" target="_blank" rel="noreferrer noopener">{{ doc.title }}</a>
            <span class="hint">{{ doc.desc }}</span>
          </li>
        </ul>
      </template>
      <p class="hint">文档已独立成站，不随框架分发。以上链接指向在线文档。</p>
    </div>

    <!-- 按插件分标签：插件多起来之后竖排要划很久才够到某一个 -->
    <div v-if="pluginNames.length > 1" class="toolbar tabs">
      <button :class="{ primary: plugin === '' }" @click="plugin = ''">
        全部 <span class="tag">{{ commands.length }}</span>
      </button>
      <button
        v-for="name in pluginNames"
        :key="name"
        :class="{ primary: plugin === name }"
        @click="plugin = name"
      >
        {{ name }} <span class="tag">{{ countByPlugin.get(name) ?? 0 }}</span>
      </button>
    </div>

    <Transition name="tab" mode="out-in">
    <div :key="plugin">
    <div class="toolbar">
      <input
        v-model="keyword"
        type="search"
        :placeholder="plugin === '' ? '按命令名、说明或触发模式筛选' : `在 ${plugin} 的命令里筛选`"
        aria-label="筛选命令"
      />
      <label class="check">
        <input v-model="showHidden" type="checkbox" />
        <span class="checkmark"></span>
        显示隐藏命令
      </label>
    </div>

    <p class="hint">
      共 {{ commands.length }} 条命令，当前显示 {{ shown }} 条<span v-if="plugin !== ''">（限于 {{ plugin }}）</span>。
    </p>

    <section v-for="[name, list] in groups" :key="name" class="card">
      <h2 class="mono">{{ name }}</h2>
      <ul class="plain">
        <li v-for="cmd in list" :key="`${name}/${cmd.name}`">
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
    </section>

    <p v-if="groups.length === 0" class="hint">
      没有符合条件的命令。命令由插件注册，内核自身不提供任何命令。
    </p>
    </div>
    </Transition>
  </div>
</template>
