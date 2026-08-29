<script setup lang="ts">
/**
 * 模块职责：插件页 —— 卡片网格列出已安装插件，就地配置，并按插件查看命令/任务/中间件
 * 依赖方向：依赖 api / format / configedit 一族组件 / types
 * 生命周期：挂载时读取一次，每次动作后重新读取；命令与中间件清单按需（打开查看时）读取
 * 注意事项：**不提供启用与停用按钮** —— 启停即配置项 `plugins.disabled`，已由内核配置的通用表单覆盖，
 *          再开专用接口就是同一项设置两个入口两套校验。
 *
 *          重载靠在模块地址上追加查询参数绕过 Node 的 ESM 缓存，**旧模块对象仍驻留在内存**（Node ESM
 *          的固有限制）。页面上明写出来，否则使用者反复重载也定位不到原因。
 *
 *          **配置是就地模态，不跳配置页**：上下文就在这张卡片上。配置页因此收窄为只有内核配置。
 *
 *          **命令清单在此按插件呈现，帮助页那份按全局呈现**，两者刻意并存（见 HelpView）。
 *          三份清单只在首次打开「查看」时拉取 —— 只想点「重载」的人不必付那三个往返。
 *
 *          **面板插件按「包」而非按「组件」列** —— 使用者装的是一个东西，逐枚列会让一个九组件的包独占九行。
 *          页签的另一半是插件自加页签的注册点，故这一页的页签数不是常量。
 *
 *          **「定时任务」一节留在页签之外**：它是页级的一节，跟着页签隐去会在切到「面板插件」时无端消失。
 *
 *          **面板插件包的「配置」按钮只对声明了配置项的包出现**，位置与核心插件一致（卡片首位、primary）。
 */
import { computed, onMounted, ref } from "vue"
import { get, post } from "../api.js"
import { errorText, statusClass, statusText } from "../format.js"
import { askConfirm } from "../confirm.js"
import { hrefOf } from "../router.js"
import ConfigEditor from "../components/ConfigEditor.vue"
import Modal from "../components/Modal.vue"
import PageHeader from "../components/PageHeader.vue"
import PanelConfigEditor from "../components/PanelConfigEditor.vue"
import { panelConfigOf } from "../panelconfig.js"
import { panelPackages, panelTabs } from "../registry.js"
import type { CommandItem, MiddlewareItem, PluginItem, TaskItem } from "../types.js"

/** 「查看」模态里的四个标签 */
const DETAIL_TABS = [
  { id: "basic", label: "基础信息" },
  { id: "commands", label: "命令" },
  { id: "tasks", label: "任务" },
  { id: "middlewares", label: "中间件" }
] as const

/**
 * 包详情模态里的两个标签
 *
 * 与 `DETAIL_TABS` 分开：面板插件包没有命令/任务/中间件，共用一套会摆出三个恒为空的标签页。
 */
const PKG_TABS = [
  { id: "basic", label: "基础信息" },
  { id: "widgets", label: "组件" }
] as const

/**
 * 三个内置页签
 *
 * 「全部插件」在最前且为默认：它对两类使用者都不会是空的。
 */
const PAGE_TABS = [
  { id: "all", label: "全部插件" },
  { id: "core", label: "核心插件" },
  { id: "panel", label: "面板插件" }
] as const

/** 事件大类的中文说法；中间件清单里逐条列出适用范围 */
const KIND_LABEL: Record<string, string> = {
  message: "消息",
  notice: "通知",
  request: "请求",
  meta: "元事件"
}

const plugins = ref<PluginItem[]>([])
const tasks = ref<TaskItem[]>([])
const commands = ref<CommandItem[]>([])
const middlewares = ref<MiddlewareItem[]>([])
const error = ref("")
const busy = ref("")
/** 三份清单是否已拉过；「查看」首次打开时拉一次 */
const registriesLoaded = ref(false)

/** 正在配置哪个插件；空串意为配置模态未开 */
const configuring = ref("")
/** 正在查看哪个插件；空串意为查看模态未开 */
const viewing = ref("")
/** 查看模态里的当前标签 */
const tab = ref<(typeof DETAIL_TABS)[number]["id"]>("basic")
/** 哪张卡片的「更多」菜单是展开的 */
const menuOpen = ref("")

/**
 * 当前页签标识：内置三个取 `PAGE_TABS` 的 id，插件贡献的取其 `TabDef.id`
 *
 * **不落盘、不进哈希**：这是「此刻在看哪一类」而非一处位置。
 */
const pageTab = ref<string>("all")

/**
 * 已装的面板插件，按包归并
 *
 * **取自注册表而非某个端点**：「装上了」的判据是它在浏览器里被 `import()` 到并通过校验，
 * 只有注册表知道这件事 —— node 侧的清单只知道磁盘上有哪些文件，其中一项可能语法错到根本没跑起来。
 *
 * 注册表在模块加载期一次填满、此后不变，故这两项都不必是响应式的。
 */
const packages = panelPackages()

/** 插件贡献的页签，接在内置三个之后 */
const pluginTabs = panelTabs()

/**
 * 包键 → 它在配置这件事上的状况（声明、当前值、声明写错了的原因）
 *
 * 只算一次：配置在装载期（`loadPanelPlugins`，早于挂载）就登记好，此后只有值会变，
 * 而值是一个 `Ref` —— 用到它的地方自会重算。
 */
const configs = new Map(packages.map(pkg => [pkg.key, panelConfigOf(pkg.key)]))

/** 正在配置哪个包；空串意为配置模态未开 */
const pkgConfiguring = ref("")

/** 正在看哪个包的详情；空串意为包详情模态未开 */
const pkgViewing = ref("")

/** 包详情模态里的当前标签 */
const pkgTab = ref<"basic" | "widgets">("basic")

/** 正在看的那个包 */
const pkgViewed = computed(() => packages.find(p => p.key === pkgViewing.value))

/** 当前页签对应的插件贡献页签定义；内置页签时为 undefined */
const activePluginTab = computed(() => pluginTabs.find(t => t.id === pageTab.value))

/**
 * 打开一个包的详情
 * @param key 包键
 */
function viewPackage(key: string): void {
  pkgViewing.value = key
  pkgTab.value = "basic"
}

/** 正在查看的那个插件 */
const viewed = computed(() => plugins.value.find(p => p.name === viewing.value))

/** 正在查看的插件所注册的命令 */
const viewedCommands = computed(() => commands.value.filter(c => c.plugin === viewing.value))

/** 正在查看的插件所注册的定时任务 */
const viewedTasks = computed(() => tasks.value.filter(t => t.plugin === viewing.value))

/** 正在查看的插件所注册的中间件，顺序即执行顺序 */
const viewedMiddlewares = computed(() => middlewares.value.filter(m => m.plugin === viewing.value))

/** 读取插件与定时任务清单 */
async function load(): Promise<void> {
  try {
    const [p, t] = await Promise.all([get<PluginItem[]>("plugins"), get<TaskItem[]>("tasks")])
    plugins.value = p
    tasks.value = t
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  }
}

/**
 * 读取命令与中间件清单
 *
 * 单独一次，且只在首次打开「查看」时 —— 只想点「重载」的人不必为此付两个往返。
 * 失败不写页面顶部的错误条：那条是给「插件列表都没读到」用的，而这两份缺失只影响
 * 模态里的两个标签，故就地写在标签内容里。
 */
async function loadRegistries(): Promise<void> {
  if (registriesLoaded.value) return
  try {
    const [c, m] = await Promise.all([get<CommandItem[]>("commands"), get<MiddlewareItem[]>("middlewares")])
    commands.value = c
    middlewares.value = m
    registriesLoaded.value = true
  } catch {
    // 留 registriesLoaded 为假，下次打开再试一次
  }
}

/**
 * 重载或卸载一个插件
 * @param name 插件名
 * @param action 动作
 */
async function act(name: string, action: "reload" | "unload"): Promise<void> {
  menuOpen.value = ""
  if (action === "unload") {
    const ok = await askConfirm({
      title: `卸载插件「${name}」？`,
      body: "该插件登记的全部资源会被回收，其功能立即不可用。安装目录仍保留，重载或重启进程即可恢复。",
      okText: "卸载",
      danger: true,
      details: ["注册的命令与定时任务一并撤销", "若该插件提供适配器或渲染器，依赖它的功能同时失效"]
    })
    if (!ok) return
  }
  busy.value = name
  try {
    await post(`plugins/${encodeURIComponent(name)}/${action}`)
    error.value = ""
    // 重载会改变命令与中间件的登记，故一并作废重取
    registriesLoaded.value = false
    await load()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 打开「查看」模态
 * @param name 插件名
 */
async function view(name: string): Promise<void> {
  menuOpen.value = ""
  viewing.value = name
  tab.value = "basic"
  await loadRegistries()
}

/**
 * 切换某张卡片的「更多」菜单
 * @param name 插件名
 */
function toggleMenu(name: string): void {
  menuOpen.value = menuOpen.value === name ? "" : name
}

onMounted(() => void load())
</script>

<template>
  <div @click="menuOpen = ''">
    <PageHeader route="plugins" sub="内核之外的全部能力均由插件提供：适配器、渲染器与业务功能" />

    <p v-if="error" class="banner">{{ error }}</p>

    <!-- 页级页签：形制取 `.toolbar.tabs`（帮助页与「查看」模态已在用），角标是「这一类有几个」 -->
    <div class="toolbar tabs">
      <button
        v-for="item in PAGE_TABS"
        :key="item.id"
        :class="{ primary: pageTab === item.id }"
        @click="pageTab = item.id"
      >
        {{ item.label }}
        <span class="tag">{{
          item.id === "all" ? plugins.length + packages.length : item.id === "core" ? plugins.length : packages.length
        }}</span>
      </button>
      <button
        v-for="item in pluginTabs"
        :key="item.id"
        :class="{ primary: pageTab === item.id }"
        @click="pageTab = item.id"
      >
        {{ item.title }}
      </button>
    </div>

    <!--
      插件贡献的页签：整块内容区交给它，与内置三类互斥（`v-else` 那一路）

      `:key` 使切换页签走完整的卸载与挂载 —— 页签内容可能持有 `onTick` 订阅，靠 `onUnmounted` 退订。

      外面那层 `div` 不是多余的：包自带的样式表每条选择器都被限定到 `[data-panel="<包键>"]`
      之下（见 `panelstyle.ts`），没有这个属性，作者写的样式在自己的页签里一条都不生效。
      栅格里的那一份由 `WidgetCell` 的外层带上。
    -->
    <div v-if="activePluginTab" :data-panel="activePluginTab.pkg">
      <component :is="activePluginTab.component" :key="activePluginTab.id" />
    </div>

    <template v-else>
      <!-- 「全部」下两类并列，故各带一个小标题；单看一类时标题与页签重复，故只在 all 出 -->
      <h2 v-if="pageTab === 'all'">核心插件（{{ plugins.length }}）</h2>
      <div v-if="pageTab !== 'panel'" class="grid plugins">
        <article v-for="p in plugins" :key="p.name" class="card item plugin">
          <header>
            <h3>{{ p.name }}</h3>
            <span class="tag" :class="statusClass(p.status)">{{ statusText(p.status) }}</span>
          </header>

          <p class="mono hint">
            {{ p.version }}<span v-if="p.builtin"> · 随发行版预置</span>
          </p>
          <p v-if="p.description" class="plugin-desc">{{ p.description }}</p>
          <p v-else class="plugin-desc hint">该插件未声明说明</p>
          <p v-if="p.error" class="err">{{ p.error }}</p>

          <!-- 三个计数与加载耗时：卡片上只给数，明细在「查看」里 -->
          <dl class="counts">
            <div><dt>命令</dt><dd>{{ p.commands }}</dd></div>
            <div><dt>任务</dt><dd>{{ p.tasks }}</dd></div>
            <div><dt>中间件</dt><dd>{{ p.middlewares }}</dd></div>
            <div><dt>加载</dt><dd>{{ p.loadCost }}ms</dd></div>
          </dl>

          <footer class="row">
            <button v-if="p.configured" class="primary" @click="configuring = p.name">配置</button>
            <button :disabled="busy === p.name" @click="void act(p.name, 'reload')">重载</button>

            <!-- 更多：查看 / 访问仓库 / 卸载。收进菜单是因为一排四五个按钮在窄卡上必然折行 -->
            <div class="menu" @click.stop>
              <button :aria-expanded="menuOpen === p.name" @click="toggleMenu(p.name)">更多 ▾</button>
              <Transition name="menu">
                <div v-if="menuOpen === p.name" class="menu-list">
                  <button @click="void view(p.name)">查看</button>
                  <a
                    v-if="p.homepage"
                    class="button"
                    :href="p.homepage"
                    target="_blank"
                    rel="noreferrer noopener"
                    @click="menuOpen = ''"
                  >
                    访问仓库
                  </a>
                  <button
                    class="danger"
                    :disabled="busy === p.name || p.status !== 'loaded'"
                    @click="void act(p.name, 'unload')"
                  >
                    卸载
                  </button>
                </div>
              </Transition>
            </div>
          </footer>
        </article>
      </div>

      <p v-if="pageTab !== 'panel' && plugins.length === 0" class="card hint">
        插件目录为空。内核默认不携带任何插件，可在<a :href="hrefOf('market')">插件市场</a>安装，
        或执行 <code>yzng plugin new 名称</code> 生成开发骨架。
      </p>

      <p v-if="pageTab !== 'panel'" class="hint">
        重载通过绕过模块缓存实现，旧模块对象仍驻留于内存，此为 Node ESM 的固有限制。该方式适用于开发调试；
        生产环境更新插件应重启进程。
      </p>

      <!--
        面板插件：一个包一张卡片

        与上方的核心插件是两回事 —— 那些在 node 侧（带命令、任务、中间件，可重载可卸载），
        这些在浏览器侧，只往面板上添几格。样式刻意相同（`.card.item.plugin`），因为使用者眼里
        同为「我装的一个插件」；差别在计数与动作：这里给组件数与页签数，且没有重载与卸载
        —— 那两个动作对浏览器侧的包无意义，摆一排灰按钮比不列出来更难解释。
      -->
      <h2 v-if="pageTab === 'all'">面板插件（{{ packages.length }}）</h2>
      <div v-if="pageTab !== 'core'" class="grid plugins">
        <article v-for="pkg in packages" :key="pkg.key" class="card item plugin">
          <header>
            <h3>{{ pkg.name }}</h3>
            <span v-if="pkg.failures.length > 0" class="tag err">{{ pkg.failures.length }} 枚未装上</span>
            <span v-else class="tag ok">已装上</span>
            <!-- 配置声明写坏了或写错了地方：卡片上给一枚徽标，缘由在详情里 -->
            <span v-if="configs.get(pkg.key)?.problem" class="tag warn">配置未生效</span>
          </header>

          <p class="mono hint">
            {{ pkg.meta?.version ?? "—" }} · {{ pkg.kind === "multi" ? "多文件" : "单文件" }}
          </p>
          <p v-if="pkg.meta?.description" class="plugin-desc">{{ pkg.meta.description }}</p>
          <p v-else class="plugin-desc hint">该插件未声明说明</p>

          <dl class="counts">
            <div><dt>组件</dt><dd>{{ pkg.widgets.length }}</dd></div>
            <div><dt>页签</dt><dd>{{ pkg.tabs.length }}</dd></div>
            <div>
              <dt>配置项</dt>
              <dd>{{ Object.keys(configs.get(pkg.key)?.schema?.properties ?? {}).length }}</dd>
            </div>
            <div><dt>作者</dt><dd>{{ pkg.meta?.author ?? "—" }}</dd></div>
          </dl>

          <footer class="row">
            <!--
              「配置」只对声明了配置项的包出现：点开是空表单的按钮比不摆更难解释。
              位置与核心插件卡片一致（首位、primary），使用者眼里这是同一件事。
            -->
            <button v-if="configs.get(pkg.key)?.schema" class="primary" @click="pkgConfiguring = pkg.key">
              配置
            </button>
            <button :class="{ primary: !configs.get(pkg.key)?.schema }" @click="viewPackage(pkg.key)">查看</button>
            <a
              v-if="pkg.meta?.repository"
              class="button"
              :href="pkg.meta.repository"
              target="_blank"
              rel="noreferrer noopener"
            >
              访问仓库
            </a>
          </footer>
        </article>
      </div>

      <p v-if="pageTab !== 'core' && packages.length === 0" class="card hint">
        尚未装任何面板插件。
      </p>

      <p v-if="pageTab !== 'core'" class="hint">
        面板插件只有一处落点：<code>plugins/webui/plugins/</code>。放进去刷新页面即生效，无须重载插件。
        单文件即一个 <code>.js</code>（须 <code>export const meta</code>）；插件包为一个子目录，
        入口固定是包根的 <code>index.js</code>，自报信息写在它的 <code>package.json</code> 里。
        该目录会被「更新 webui」清空，请留一份备份。
      </p>
    </template>

    <h2>定时任务（{{ tasks.length }}）</h2>
    <div class="card">
      <table class="rows">
        <thead>
          <tr>
            <th>任务</th>
            <th>所属插件</th>
            <th>排程</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in tasks" :key="`${t.plugin}:${t.name}`">
            <td data-label="任务">{{ t.name }}</td>
            <td data-label="所属插件">{{ t.plugin }}</td>
            <td data-label="排程" class="mono">{{ t.schedule }}</td>
            <td data-label="状态">
              <span class="tag" :class="t.running ? 'warn' : ''">{{ t.running ? "执行中" : "空闲" }}</span>
              <span v-if="t.skipped > 0" class="tag warn">跳过 {{ t.skipped }} 次</span>
            </td>
          </tr>
          <tr v-if="tasks.length === 0">
            <td colspan="4" class="hint">尚无定时任务</td>
          </tr>
        </tbody>
      </table>
      <p v-if="tasks.some(t => t.skipped > 0)" class="hint">
        「跳过」为重入保护：上一轮尚未执行完毕即到达下一触发点时该轮被跳过。多次出现说明任务耗时超过其执行间隔。
      </p>
    </div>

    <!-- 配置：就地模态，不跳配置页 -->
    <Modal
      :open="configuring !== ''"
      wide
      :title="`配置「${configuring}」`"
      sub="表单由该插件的 schema 声明自动生成，保存后立即生效"
      @close="configuring = ''"
    >
      <ConfigEditor v-if="configuring !== ''" :name="configuring" />
    </Modal>

    <!-- 查看：四个标签 -->
    <Modal
      :open="viewing !== ''"
      wide
      :title="`插件「${viewing}」`"
      :sub="viewed?.description"
      @close="viewing = ''"
    >
      <div class="toolbar tabs">
        <button
          v-for="item in DETAIL_TABS"
          :key="item.id"
          :class="{ primary: item.id === tab }"
          @click="tab = item.id"
        >
          {{ item.label }}
        </button>
      </div>

      <template v-if="viewed">
        <dl v-if="tab === 'basic'" class="facts">
          <dt>版本</dt>
          <dd class="mono">{{ viewed.version }}</dd>
          <dt>状态</dt>
          <dd><span class="tag" :class="statusClass(viewed.status)">{{ statusText(viewed.status) }}</span></dd>
          <dt v-if="viewed.author">作者</dt>
          <dd v-if="viewed.author">{{ viewed.author }}</dd>
          <dt>安装目录</dt>
          <dd class="mono">{{ viewed.root }}</dd>
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

    <!--
      包详情：两个标签

      **失败的组件列在同一张表里，不另设一节** —— 使用者找的是「我装的那枚组件在哪」，
      按成败分两处列，他得先知道自己该去哪一处找。
    -->
    <Modal
      :open="pkgViewing !== ''"
      wide
      :title="`面板插件「${pkgViewed?.name ?? ''}」`"
      :sub="pkgViewed?.meta?.description"
      @close="pkgViewing = ''"
    >
      <div class="toolbar tabs">
        <button
          v-for="item in PKG_TABS"
          :key="item.id"
          :class="{ primary: item.id === pkgTab }"
          @click="pkgTab = item.id"
        >
          {{ item.label }}
        </button>
      </div>

      <template v-if="pkgViewed">
        <dl v-if="pkgTab === 'basic'" class="facts">
          <dt>版本</dt>
          <dd class="mono">{{ pkgViewed.meta?.version ?? "—" }}</dd>
          <dt>形态</dt>
          <dd>{{ pkgViewed.kind === "multi" ? "多文件（一个目录，入口 index.js）" : "单文件（一个 .js）" }}</dd>
          <dt>作者</dt>
          <dd>{{ pkgViewed.meta?.author ?? "—" }}</dd>
          <dt>组件</dt>
          <dd>
            {{ pkgViewed.widgets.length }} 枚<span v-if="pkgViewed.failures.length > 0" class="err">
              （其中 {{ pkgViewed.failures.length }} 枚未装上）</span>
          </dd>
          <dt>本页页签</dt>
          <dd>{{ pkgViewed.tabs.length === 0 ? "未贡献" : pkgViewed.tabs.map(t => t.title).join("、") }}</dd>
          <dt>配置项</dt>
          <dd>
            <template v-if="configs.get(pkgViewed.key)?.schema">
              {{ Object.keys(configs.get(pkgViewed.key)?.schema?.properties ?? {}).length }} 项，可在卡片上点「配置」修改；
              值存在 <span class="mono">data/plugin/webui/panelconfig/{{ pkgViewed.key }}.json</span>
            </template>
            <template v-else>未声明 —— 这个包没有可改的配置项</template>
          </dd>
          <!--
            声明写坏了或写错了地方：这一行是它唯一的去处

            两种情形都只表现为「配置按钮没出现」，而作者刚刚明明写下了它。
          -->
          <dt v-if="configs.get(pkgViewed.key)?.problem">配置声明</dt>
          <dd v-if="configs.get(pkgViewed.key)?.problem" class="err">
            {{ configs.get(pkgViewed.key)?.problem }}
          </dd>
          <dt>包键</dt>
          <dd class="mono">{{ pkgViewed.key }}</dd>
          <dt v-if="pkgViewed.meta?.repository">仓库</dt>
          <dd v-if="pkgViewed.meta?.repository">
            <a :href="pkgViewed.meta.repository" target="_blank" rel="noreferrer noopener">
              {{ pkgViewed.meta.repository }}
            </a>
          </dd>
        </dl>

        <template v-if="pkgTab === 'widgets'">
          <table v-if="pkgViewed.widgets.length > 0" class="rows panelrows">
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
              <tr v-for="w in pkgViewed.widgets" :key="w.id">
                <td data-label="组件">
                  {{ w.title }}
                  <span v-if="w.failure" class="tag err">未装上</span>
                </td>
                <td data-label="标识" class="mono">{{ w.id }}</td>
                <td data-label="所在页">{{ w.page }}</td>
                <td data-label="默认尺寸" class="mono">{{ w.layout.w }} × {{ w.layout.h }}</td>
                <td data-label="可调">{{ w.layout.resizable === true ? "可" : "固定" }}</td>
              </tr>
              <tr v-for="w in pkgViewed.failures" :key="`${w.id}:why`">
                <td colspan="5" class="err">{{ w.title }}：{{ w.failure }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="hint">该包一枚组件都没有，只贡献了页签。</p>
        </template>
      </template>
    </Modal>

    <!--
      面板插件包的配置：另一个模态，不并进上面那张详情

      详情是「这个包是什么」，配置是「改这个包的行为」—— 后者是一次会写盘的动作，
      与前者摆在同一处会让人在读说明时误点。核心插件那边也是这么分的（卡片上两个按钮，
      两个模态）。
    -->
    <Modal
      :open="pkgConfiguring !== ''"
      wide
      :title="`配置面板插件「${pkgConfiguring.slice(pkgConfiguring.indexOf('/') + 1)}」`"
      sub="表单由这个包 package.json 里的 webuiPanel.config 声明自动生成，保存后立即生效"
      @close="pkgConfiguring = ''"
    >
      <PanelConfigEditor v-if="pkgConfiguring !== ''" :pkg="pkgConfiguring" />
    </Modal>
  </div>
</template>
