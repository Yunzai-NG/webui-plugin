<script setup lang="ts">
/**
 * 模块职责：插件页 —— 卡片网格列出已安装插件，就地配置，并按插件查看命令/任务/中间件
 * 依赖方向：依赖 api / format / configedit 一族组件 / types
 * 生命周期：挂载时读取一次，每次动作后重新读取；命令与中间件清单按需（打开查看时）读取
 * 注意事项：不提供启用与停用按钮 —— 启停即配置项 `plugins.disabled`，已由内核配置的通用表单覆盖。
 *
 *          重载靠在模块地址上追加查询参数绕过 Node 的 ESM 缓存，旧模块对象仍驻留在内存（Node ESM
 *          的固有限制）。页面上明写出来，否则使用者反复重载也定位不到原因。
 *
 *          配置是就地模态，不跳配置页；配置页因此收窄为只有内核配置。命令清单在此按插件呈现，
 *          帮助页那份按全局呈现，两者刻意并存（见 HelpView）。三份清单只在首次打开「查看」时拉取。
 *
 *          面板插件按「包」而非按「组件」列，故这一页的页签数不是常量（另一半是插件自加页签的
 *          注册点）。「定时任务」一节留在页签之外：跟着页签隐去会在切到「面板插件」时无端消失。
 */
import { computed, nextTick, onMounted, ref } from "vue"
import { useAction } from "../action.js"
import { del, get, post } from "../api.js"
import { errorText, statusClass, statusText } from "../format.js"
import { askConfirm, askConfirm3 } from "../confirm.js"
import { installDirOf, resultText, setupResultText } from "../market.js"
import { hrefOf } from "../router.js"
import ConfigEditor from "../components/ConfigEditor.vue"
import Modal from "../components/Modal.vue"
import PackageDetail from "../components/PackageDetail.vue"
import PageHeader from "../components/PageHeader.vue"
import PanelConfigEditor from "../components/PanelConfigEditor.vue"
import PluginDetail from "../components/PluginDetail.vue"
import TabBar from "../components/TabBar.vue"
import { panelConfigOf } from "../panelconfig.js"
import { panelPackages, panelTabs } from "../registry.js"
import type {
  CommandItem,
  MarketInstallResult,
  MarketItem,
  MarketSetupResult,
  MarketSnapshot,
  MiddlewareItem,
  PluginItem,
  TaskItem,
  UpdateProbe
} from "../types.js"

/**
 * 菜单与触发按钮之间的间隙，px
 *
 * 与样式表里 `.menu-list` 的 `margin-top: var(--s1)` 同一个值。两处各写一份的代价只是
 * 判翻转时差 4px，不值得为它读一次 computed style。
 */
const MENU_GAP = 4

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

const plugins = ref<PluginItem[]>([])
const tasks = ref<TaskItem[]>([])
const commands = ref<CommandItem[]>([])
const middlewares = ref<MiddlewareItem[]>([])
const { error, busy, run } = useAction()
/** 一次管理动作之后要说的那句话；空串意为无话可说 */
const notice = ref("")
/** 三份清单是否已拉过；「查看」首次打开时拉一次 */
const registriesLoaded = ref(false)

/** 正在配置哪个插件；空串意为配置模态未开 */
const configuring = ref("")
/** 正在查看哪个插件；空串意为查看模态未开 */
const viewing = ref("")
/** 哪张卡片的「更多」菜单是展开的 */
const menuOpen = ref("")
/**
 * 展开的那个菜单是否朝上弹
 *
 * 单个 ref 足够：`menuOpen` 一次只容一个菜单展开。
 */
const menuUp = ref(false)

/**
 * 市场索引，按**安装目录名**索引
 *
 * **只为两件事而拉：判「可更新」与预告装后步骤。** 管理动作本身不需要它 —— 手工放进插件目录的
 * 插件压根不在索引里，而那恰是最需要「装依赖并编译」的一类。故取不到索引时按钮照旧可用，
 * 只是少了版本对比那一行。
 *
 * 失败不写页面顶部的错误条：那条是给「插件列表都没读到」用的，而索引缺失只影响一行提示。
 */
const marketItems = ref<Map<string, MarketItem>>(new Map())

/**
 * 一个插件在索引里的条目
 * @param dir 安装目录名，取自 {@link dirOf}
 * @returns 条目；索引里没有或索引没拉到时 undefined
 */
function marketOf(dir: string): MarketItem | undefined {
  return marketItems.value.get(dir)
}

/**
 * 一个插件的**安装目录名** —— 市场一切动作的寻址单位
 *
 * 判据与理由都在 {@link installDirOf}；此处只是把插件项摊成它的两个参数。
 * @param p 插件
 * @returns 安装目录名
 */
function dirOf(p: PluginItem): string {
  return installDirOf(p.root, p.name)
}

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

/** 页级页签：内置三类带条目数，其后接插件贡献的页签 */
const pageTabs = computed(() => [
  ...PAGE_TABS.map(item => ({
    ...item,
    count:
      item.id === "all" ? plugins.value.length + packages.length : item.id === "core" ? plugins.value.length : packages.length
  })),
  ...pluginTabs.map(item => ({ id: item.id, label: item.title }))
])

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

/** 当前页签对应的插件贡献页签定义；内置页签时为 undefined */
const activePluginTab = computed(() => pluginTabs.find(t => t.id === pageTab.value))

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
 * 读取市场索引，供「可更新」判据与装后步骤声明
 *
 * 单独一路，失败不写顶部错误条：索引取不到（多半是没网）时插件页仍须能重载、能卸载，
 * 故降级成「少一枚徽标」而非「整页报错」。走缓存不回源，打开速度不取决于网络。
 */
async function loadMarket(): Promise<void> {
  try {
    const snapshot = await get<MarketSnapshot>("market")
    marketItems.value = new Map(snapshot.plugins.map(item => [item.name, item]))
  } catch {
    // 索引取不到就当没有：卡片少一枚「可更新」徽标，管理动作照旧可用
    marketItems.value = new Map()
  }
}

/**
 * 读取命令与中间件清单
 *
 * 只在首次打开「查看」时拉一次。失败不写顶部错误条：那条是给「插件列表都没读到」用的，
 * 而这两份缺失只影响模态里的两个标签，故就地写在标签内容里。
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
 *
 * 与那四个管理动作同走 `flowOf`：卸载也要问一次，而**问句是单例的** —— 一边等着卸载的确认、
 * 一边点另一个插件的更新，先来的那一问会被按「取消」结算掉。
 * @param name 插件名
 * @param action 动作
 */
async function act(name: string, action: "reload" | "unload"): Promise<void> {
  menuOpen.value = ""
  await flowOf(name, async () => {
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
    await run(name, async () => {
      await post(`plugins/${encodeURIComponent(name)}/${action}`)
      // 重载会改变命令与中间件的登记，故一并作废重取
      registriesLoaded.value = false
      await load()
    })
  })
}

/**
 * 「装完之后还会做什么」那几句，更新、重装与「装依赖并编译」三个确认框共用
 *
 * 逐条写出来而不是一句「会自动装依赖」：`install:browser` 那类装后步骤要下载上百兆的运行时，
 * 事先不说会让人以为界面卡住了。索引里没有这个插件时只说得出装依赖那一半 —— 装后步骤是
 * **索引**声明的，手放进来的插件没有那份声明。
 * @param dir 安装目录名，取自 {@link dirOf}
 * @returns 说明行
 */
function setupNotes(dir: string): string[] {
  const notes = [
    "会在插件目录内执行 pnpm install（找不到 pnpm 时退回 npm），那一步会执行该插件依赖的 install 脚本"
  ]
  const scripts = marketOf(dir)?.setup?.scripts ?? []
  if (scripts.length > 0) {
    notes.push(`随后按索引声明依次执行 ${scripts.join("、")} —— 其中可能包含编译与运行时下载，耗时可达数分钟`)
  }
  notes.push("这不是一道新的信任边界：插件入口下一秒就会被内核 import() 执行，与 install 脚本同属一道门")
  return notes
}

/**
 * 探测一次更新会怎么走：会不会就地拉取、目录里有没有改动
 *
 * **探测失败不挡住更新。** 那时返回 undefined，调用方按「没有改动」发请求 —— 内核撞上改动
 * 会以 400 中止且目录停在原样，比因为一次探测失败就点不动更新要好。
 * @param name 插件名
 * @returns 探测结果；探测失败时 undefined
 */
async function probeUpdate(name: string): Promise<UpdateProbe | undefined> {
  try {
    return await get<UpdateProbe>(`market/${encodeURIComponent(name)}/update-probe`)
  } catch {
    return undefined
  }
}

/**
 * 有一条管理流程正在进行（含确认、探测与请求三段）；空串意为空闲
 *
 * 与 `busy` 分开两个状态，因为**它们盖住的区间不同**：`busy` 只在请求飞着的那一段为真，
 * 而这一个从点下按钮起、到结果落地为止全程为真。
 * @see locked 用它禁用按钮的理由
 */
const flow = ref("")

/**
 * 此刻是否有管理流程在进行；为真时全部管理按钮禁用
 *
 * **不允许两个插件同时更新。** 那个「要不要暂存」的问句是串行的 —— 全站只有一个确认框实例
 * （见 `confirm.ts`），第二问到来时第一问会被按「取消」结算，于是使用者看到的是「我明明点了
 * 暂存，它却说更新取消了」。
 *
 * 光靠 `busy` 不够：确认与探测那两段它还是空的。问句那一段有原生 `<dialog>` 的遮罩兜着
 * （背后点不动），但探测那一次 GET 没有遮罩 —— 那个窗口虽短，正是并发进来的缝。
 */
const locked = computed(() => flow.value !== "" || busy.value !== "")

/**
 * 把一条管理流程整个圈起来，确保退出时解锁
 *
 * 每条流程都有多个提前 return（取消确认、取消暂存），逐处补 `flow.value = ""` 必然漏一处，
 * 而漏掉的症状是**整页的管理按钮从此全灰**，且刷新之后就好了 —— 那种缺陷极难复现。
 * @param name 插件名
 * @param steps 这条流程要做的事
 */
async function flowOf(name: string, steps: () => Promise<void>): Promise<void> {
  if (locked.value) return
  flow.value = name
  try {
    await steps()
  } finally {
    flow.value = ""
  }
}

/**
 * 跑一次会改动磁盘的管理动作，并把结果说成一句话
 *
 * 四个动作（更新、重装、装依赖并编译、删除）的收尾完全一样：写提示、清错误、重取清单、
 * 作废命令与中间件那两份缓存。抽出来是因为**漏掉最后那一项不会立刻出错** —— 页面上
 * 的命令数照旧是对的，直到某次重载之后它悄悄停在旧值上。
 * @param name 插件名
 * @param task 真正发请求的那一步，返回要显示的提示
 */
async function manage(name: string, task: () => Promise<string>): Promise<void> {
  menuOpen.value = ""
  notice.value = ""
  await run(name, async () => {
    notice.value = await task()
    // 这些动作都会换掉磁盘上的代码并重载，命令与中间件的登记随之改变
    registriesLoaded.value = false
    await load()
  })
}

/**
 * 更新一个插件
 *
 * 走哪条路由内核判定，故确认文案须把两种后果都写出来。撞上本地改动时再问一次，那一问不可
 * 关闭：流程是先探测 → 有改动就问 → 带着答案发请求。
 * @param p 插件
 */
async function update(p: PluginItem): Promise<void> {
  menuOpen.value = ""
  await flowOf(p.name, async () => {
    const dir = dirOf(p)
    const entry = marketOf(dir)
    const ok = await askConfirm({
      title: `更新插件「${p.name}」？`,
      body: "更新方式由内核判定：插件目录是 git 仓库时就地拉取，否则先卸载再重新下载整个目录。",
      okText: "更新",
      details: [
        `当前 ${p.version}${entry?.version === undefined ? "" : `，索引声明 ${entry.version}`}`,
        "就地拉取：目录重置到远端最新提交，已装的依赖保留",
        "退回重装：先卸载当前版本，目录整份替换（含 node_modules）；下载失败时该插件将处于未加载状态",
        "两条路都不影响插件的配置与数据库 —— 它们不在安装目录内",
        ...setupNotes(dir)
      ]
    })
    if (!ok) return

    const probe = await probeUpdate(dir)
    let onDirty: "stash" | "discard" | undefined
    if (probe?.dirty === true) {
      /*
       * 这一问不可关闭，且带 10 秒倒计时：它卡在一个已经开始的动作中途，按 Esc 不是「什么都
       * 没发生」而是让那次更新以一条 400 收场。倒计时永不落在「丢弃」上 —— 那一路不可撤销，
       * 不该因为人走开了而自己发生（见 ConfirmDialog 里 `altText` 那段）。
       */
      const answer = await askConfirm3({
        title: `「${p.name}」的目录内有未提交的改动`,
        body: "更新会把目录重置到远端最新提交。这些改动要先暂存起来、直接丢掉，还是取消这次更新？",
        okText: "暂存并更新",
        cancelText: "取消更新",
        altText: "丢弃改动并更新",
        dismissible: false,
        countdown: 10,
        timeoutOk: true,
        details: [
          "暂存：改动收进 git 的暂存区，更新完可在该目录执行 git stash pop 取回",
          "丢弃：改动连同新增的文件一起清掉，没有副本，取不回来",
          "取消：这次更新不做，目录停在原样 —— 你可以自己处理那些改动之后再来",
          "改动包括未跟踪的新文件：它们同样会被更新时的 checkout 撞上",
          "倒计时结束按「暂存并更新」处理"
        ]
      })
      if (answer === "cancel") return
      onDirty = answer === "alt" ? "discard" : "stash"
    }

    await manage(p.name, async () =>
      resultText(
        await post<MarketInstallResult>(
          `market/${encodeURIComponent(dir)}/update`,
          // 没问过就不带这一项：让内核那侧的缺省（abort）成为唯一的缺省，两处各写一个迟早分叉
          onDirty === undefined ? {} : { onDirty }
        )
      )
    )
  })
}

/**
 * 整份重装一个插件
 *
 * 与「更新」的差别是跳过就地拉取：目录被改花了、产物与源码对不上时要的正是整份换掉。
 * 收在「更多」里 —— 它比更新慢得多（依赖跟着重装）。
 * @param p 插件
 */
async function reinstall(p: PluginItem): Promise<void> {
  menuOpen.value = ""
  await flowOf(p.name, async () => {
    const dir = dirOf(p)
    const ok = await askConfirm({
      title: `重装插件「${p.name}」？`,
      body: "不走就地拉取，从索引重新下载整个目录并替换。",
      okText: "重装",
      danger: true,
      details: [
        "**目录整份替换，含 node_modules** —— 那份依赖要重装一遍，在国内网络下可能等上几分钟",
        "目录内不属于仓库的东西一并消失：插件写在安装目录下的缓存、你自己放进去的资源",
        "配置与数据库不在安装目录内，不受影响",
        "下载失败时该插件将处于未加载状态 —— 旧目录已被删除",
        ...setupNotes(dir),
        "多数情形该点的是「更新」：那一条在目录是 git 仓库时只拉取变化，保住已装的依赖"
      ]
    })
    if (!ok) return
    await manage(p.name, async () =>
      resultText(await post<MarketInstallResult>(`market/${encodeURIComponent(dir)}/update`, { fresh: true }))
    )
  })
}

/**
 * 单独重跑装依赖与装后步骤，不重新取源
 *
 * 三种情形要用到：手工放进插件目录的、装的时候这一步失败过的、自己 `git pull` 过而 `dist/`
 * 已旧的。不在索引里的插件同样可用，那时只装依赖。
 * @param p 插件
 */
async function setup(p: PluginItem): Promise<void> {
  menuOpen.value = ""
  await flowOf(p.name, async () => {
    const dir = dirOf(p)
    const ok = await askConfirm({
      title: `为「${p.name}」装依赖并编译？`,
      body: "不重新下载插件内容，只在现有目录内装依赖、并按索引声明跑装后步骤。",
      okText: "执行",
      details: [
        "依赖已装好时包管理器会自行跳过，故重复执行是安全的",
        ...setupNotes(dir),
        "跑完会重载该插件 —— 编译产物换掉之后，内存里那份旧模块仍在响应命令"
      ]
    })
    if (!ok) return
    await manage(p.name, async () =>
      setupResultText(await post<MarketSetupResult>(`market/${encodeURIComponent(dir)}/setup`))
    )
  })
}

/**
 * 删除一个插件的安装目录
 *
 * 与「卸载」是两件事，故两个按钮：卸载只摘掉内存里那份（重载即回来），删除动的是磁盘。
 * @param p 插件
 */
async function remove(p: PluginItem): Promise<void> {
  await flowOf(p.name, async () => {
    menuOpen.value = ""
    const dir = dirOf(p)
    const ok = await askConfirm({
      title: `删除插件「${p.name}」？`,
      body: "整个安装目录会被移除，无法撤销。",
      okText: "删除",
      danger: true,
      // 配置与数据库不在插件目录内（见内核 market.ts 的 remove()：「配置文件与数据库另行存放，
      // 保留它们使得重新安装后原有配置仍然有效」），故此处不能写「需重新配置」
      details: [
        `要删的目录是 plugins/${dir}`,
        "与「卸载」不同：卸载只摘掉内存里那份，重载即回来；这一条动的是磁盘",
        "配置文件与数据库另行存放，不会被删除",
        "重新安装同名插件后，原有配置仍然有效"
      ]
    })
    if (!ok) return
    await manage(p.name, async () => {
      await del(`market/${encodeURIComponent(dir)}`)
      return `${p.name} 的安装目录已删除。`
    })
  })
}

/**
 * 打开「查看」模态
 * @param name 插件名
 */
async function view(name: string): Promise<void> {
  menuOpen.value = ""
  viewing.value = name
  await loadRegistries()
}

/**
 * 切换某张卡片的「更多」菜单
 *
 * 按视口剩余空间决定往上还是往下弹。高度是打开后量的（项数按插件而变），故要等这一帧渲染完
 * 的 `nextTick`。只在下方放不下、且上方比下方宽裕时才翻转 —— 只判前一条会在上下都不够高的
 * 窗口里翻到更挤的一侧。
 * @param name 插件名
 * @param ev 点击事件，用于取触发按钮的位置
 */
async function toggleMenu(name: string, ev: MouseEvent): Promise<void> {
  if (menuOpen.value === name) {
    menuOpen.value = ""
    return
  }
  menuOpen.value = name
  menuUp.value = false

  const trigger = ev.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  await nextTick()
  const list = trigger.parentElement?.querySelector(".menu-list")
  if (!(list instanceof HTMLElement)) return

  const rect = trigger.getBoundingClientRect()
  const need = list.offsetHeight + MENU_GAP
  const below = window.innerHeight - rect.bottom
  menuUp.value = below < need && rect.top > below
}

onMounted(() => void load())
</script>

<template>
  <div @click="menuOpen = ''">
    <PageHeader route="plugins" sub="内核之外的全部能力均由插件提供：适配器、渲染器与业务功能" />

    <p v-if="error" class="banner">{{ error }}</p>
    <!--
      管理动作的结果条

      四个动作（更新、重装、装依赖并编译、删除）的结果都落在这里，而不是各自弹一次 ——
      那几句话要说的是「装依赖成了没有、下一步该做什么」，一闪而过的提示读不完。
    -->
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <TabBar v-model="pageTab" :items="pageTabs" label="插件分类" />

    <!--
      插件贡献的页签：整块内容区交给它，与内置三类互斥（`v-else` 那一路）

      `:key` 使切换页签走完整的卸载与挂载 —— 页签内容可能持有 `onTick` 订阅，靠 `onUnmounted` 退订。

      外面那层 `div` 不是多余的：包自带的样式表每条选择器都被限定到 `[data-panel="<包键>"]`
      之下（见 `panelstyle.ts`），没有这个属性，作者写的样式在自己的页签里一条都不生效。
      栅格里的那一份由 `WidgetCell` 的外层带上。
    -->
    <Transition name="tab" mode="out-in">
    <div v-if="activePluginTab" :key="activePluginTab.id" :data-panel="activePluginTab.pkg">
      <component :is="activePluginTab.component" :key="activePluginTab.id" />
    </div>

    <div v-else :key="pageTab">
      <!-- 「全部」下两类并列，故各带一个小标题；单看一类时标题与页签重复，故只在 all 出 -->
      <h2 v-if="pageTab === 'all'">核心插件（{{ plugins.length }}）</h2>
      <div v-if="pageTab !== 'panel'" class="grid plugins">
        <article v-for="p in plugins" :key="p.name" class="card item plugin">
          <header>
            <h3>{{ p.name }}</h3>
            <span class="tag" :class="statusClass(p.status)">{{ statusText(p.status) }}</span>
            <span v-if="marketOf(dirOf(p))?.updatable" class="tag warn">可更新</span>
          </header>

          <!-- 可更新时给「旧 → 新」：只给一个数看不出该不该更新 -->
          <p class="mono hint">
            {{ p.version
            }}<span v-if="marketOf(dirOf(p))?.updatable"> → {{ marketOf(dirOf(p))?.version }}</span
            ><span v-if="p.builtin"> · 随发行版预置</span>
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

          <!--
            盒子外三个，其余进「更多」

            外面留的是「常点」与「此刻该点」：配置、更新、重载。更新只对索引说了更高版本的
            插件出现 —— 对着一个已是最新的插件摆一个更新按钮，点下去只换回同一个东西。

            重装、装依赖并编译、删除都收进菜单：它们要么慢（重装连依赖一起重下），要么少用
            （装依赖并编译多半只在装坏过一次之后用得上）。一排六个按钮在窄卡上必然折行。
          -->
          <footer class="row">
            <button v-if="p.configured" class="primary" @click="configuring = p.name">配置</button>
            <button
              v-if="marketOf(dirOf(p))?.updatable"
              :class="{ primary: !p.configured }"
              :disabled="locked"
              @click="void update(p)"
            >
              更新
            </button>
            <button :disabled="locked" @click="void act(p.name, 'reload')">重载</button>

            <div class="menu" @click.stop>
              <button :aria-expanded="menuOpen === p.name" @click="void toggleMenu(p.name, $event)">更多 ▾</button>
              <Transition name="menu">
                <div v-if="menuOpen === p.name" class="menu-list" :class="{ up: menuUp }">
                  <button @click="void view(p.name)">查看</button>
                  <!--
                    已是最新时「更新」不在盒子外，但菜单里仍留一条

                    索引没拉到、或这个插件压根不在索引里时，同样只在菜单里 —— 那时判不出
                    该不该更新，而按钮点下去内核会照旧试一次。
                  -->
                  <button
                    v-if="!marketOf(dirOf(p))?.updatable"
                    :disabled="locked"
                    @click="void update(p)"
                  >
                    更新
                  </button>
                  <button :disabled="locked" @click="void setup(p)">装依赖并编译</button>
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
                    :disabled="locked || p.status !== 'loaded'"
                    @click="void act(p.name, 'unload')"
                  >
                    卸载
                  </button>
                  <button class="danger" :disabled="locked" @click="void reinstall(p)">重装</button>
                  <button class="danger" :disabled="locked" @click="void remove(p)">删除目录</button>
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
            <button :class="{ primary: !configs.get(pkg.key)?.schema }" @click="pkgViewing = pkg.key">查看</button>
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
    </div>
    </Transition>

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
    <PluginDetail
      :name="viewing"
      :plugins="plugins"
      :commands="commands"
      :tasks="tasks"
      :middlewares="middlewares"
      @close="viewing = ''"
    />

    <!-- 包详情：两个标签 -->
    <PackageDetail :pkg="pkgViewing" :packages="packages" @close="pkgViewing = ''" />

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
