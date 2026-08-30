<script setup lang="ts">
/**
 * 模块职责：插件市场页 —— 浏览索引、安装、更新与卸载社区插件
 * 依赖方向：依赖 api / format / router / types
 * 生命周期：挂载时读取一次索引（允许命中缓存），刷新与安装后重新读取
 * 注意事项：**默认读缓存，刷新是显式动作**（生存期由 `market.cacheTtl` 定）—— 索引不会在分钟级变化，
 *          每次进页面都回源只会让打开速度取决于网络。
 *
 *          **取源失败与索引里没有条目分开呈现**：前者查 `market.sources` 与 `market.mirror`，
 *          后者是索引本身为空。合成一句「没有可用插件」会让排查方向完全偏离。
 *
 *          **内核现在代跑包管理器**（装依赖、并按索引声明跑 `build` 一类的装后步骤），故装完
 *          多半不必再动手。但那一步可能失败，且手工放进插件目录的插件压根没经过安装动作 ——
 *          故「装依赖并编译」是一个独立可发起的动作，收在「更多」菜单里。
 *
 *          确认框须把「会执行什么」写明：装依赖等于执行该插件依赖的 install 脚本，而装后步骤
 *          是索引声明的 npm script。那是知情同意的「知情」那一半 —— 但它不是一道新的信任边界，
 *          插件入口下一秒就会被内核 `import()` 执行。
 *
 *          「配置」按钮指向**插件页**而非配置页（配置入口已收归插件页的模态）。不带 `name` 参数 ——
 *          插件页没有「打开即展开某张卡片配置」这条深链，带一个用不上的参数只会让人以为它有效。
 *
 *          更新有两条路，走哪条由内核判定、前端在点确认时并不知道，故确认文案须把两种后果都写出来 ——
 *          只说「安装前会先卸载当前版本」在就地拉取那一路是假的，会让人以为更新比实际更危险。
 */
import { computed, onMounted, ref } from "vue"
import { del, get, post } from "../api.js"
import { datetime, errorText } from "../format.js"
import { askConfirm } from "../confirm.js"
import { resultText, setupResultText } from "../market.js"
import { hrefOf } from "../router.js"
import PageHeader from "../components/PageHeader.vue"
import type { MarketInstallResult, MarketItem, MarketSetupResult, MarketSnapshot } from "../types.js"

const snapshot = ref<MarketSnapshot | undefined>(undefined)
const error = ref("")
const notice = ref("")
const busy = ref("")
const loading = ref(false)
const keyword = ref("")
const onlyOfficial = ref(false)

/** 哪张卡片的「更多」菜单是展开的，空串表示都收着；同时最多一个，与插件页一致 */
const menuOpen = ref("")

/**
 * 两个页签
 *
 * **只有「全部」与「已安装」，没有「可更新」**：这份快照只带 `installed` 一个布尔值，判不出可更新。
 * 面板商店那边有三个，因为它的 node 侧读得到磁盘上包的 `package.json`。要在此处补上，得多拉一份
 * 插件页的清单再按名字对起来 —— 那是把内核该给的事实挪到前端拼，属于内核那侧的改动。
 */
const PAGE_TABS = [
  { id: "all", label: "全部" },
  { id: "installed", label: "已安装" }
] as const

/** 当前页签 */
const tab = ref<(typeof PAGE_TABS)[number]["id"]>("all")

/** 索引获取失败的地址 */
const badSources = computed(() => snapshot.value?.sources.filter(s => !s.ok) ?? [])

/** 全部条目 */
const items = computed(() => snapshot.value?.plugins ?? [])

/** 逐页签的条目数，供角标 */
const counts = computed(() => ({
  all: items.value.length,
  installed: items.value.filter(item => item.installed).length
}))

/** 按页签、关键词与官方标记过滤后的条目 */
const visible = computed(() => {
  const word = keyword.value.trim().toLowerCase()
  return items.value.filter(item => {
    if (tab.value === "installed" && !item.installed) return false
    if (onlyOfficial.value && !item.official) return false
    if (word === "") return true
    const haystack = [item.name, item.title, item.description, item.author ?? "", ...item.tags].join(" ").toLowerCase()
    return haystack.includes(word)
  })
})

/**
 * 读取索引
 * @param refresh 是否强制回源
 */
async function load(refresh = false): Promise<void> {
  loading.value = true
  try {
    snapshot.value = refresh
      ? await post<MarketSnapshot>("market/refresh")
      : await get<MarketSnapshot>("market")
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}

/**
 * 「装完之后还会做什么」那几句，安装与更新的确认框共用
 *
 * 逐条写出来而不是一句「会自动装依赖」：`install:browser` 那类装后步骤要下载上百兆的
 * 运行时，事先不说会让人以为界面卡住了。
 * @param item 目标条目
 * @returns 说明行；该插件无装后步骤时只有装依赖那一条
 */
function setupNotes(item: MarketItem): string[] {
  const notes = [
    "装完会在插件目录内执行 pnpm install（找不到 pnpm 时退回 npm），那一步会执行该插件依赖的 install 脚本"
  ]
  const scripts = item.setup?.scripts ?? []
  if (scripts.length > 0) {
    notes.push(
      `随后按索引声明依次执行 ${scripts.join("、")} —— 其中可能包含编译与运行时下载，耗时可达数分钟`
    )
  }
  notes.push("这不是一道新的信任边界：插件入口下一秒就会被内核 import() 执行，与 install 脚本同属一道门")
  return notes
}

/**
 * 安装或更新一个插件
 * @param item 目标条目
 * @param update 已安装时是否按更新处理
 */
async function install(item: MarketItem, update: boolean): Promise<void> {
  const ok = update
    ? await askConfirm({
        title: `更新插件「${item.name}」？`,
        body: "更新方式由内核判定：插件目录是 git 仓库时就地拉取，否则先卸载再重新下载整个目录。",
        okText: "更新",
        details: [
          `当前索引声明的版本：${item.version ?? "未声明"}`,
          "就地拉取：目录重置到远端最新提交，已装的依赖保留；本地改动自动暂存，可用 git stash pop 取回",
          "退回重装：先卸载当前版本，目录整份替换（含 node_modules）；下载失败时该插件将处于未加载状态",
          "两条路都不影响插件的配置与数据库 —— 它们不在安装目录内",
          ...setupNotes(item)
        ]
      })
    : await askConfirm({
        title: `安装插件「${item.title}」？`,
        body: "从索引取源并装到内核的插件目录，装完自动装依赖并按索引声明完成编译。",
        okText: "安装",
        details: [`落点：plugins/${item.name}/`, ...setupNotes(item)]
      })
  if (!ok) return
  busy.value = item.name
  notice.value = ""
  try {
    const result = update
      ? await post<MarketInstallResult>(`market/${encodeURIComponent(item.name)}/update`)
      : await post<MarketInstallResult>("market/install", { name: item.name })
    notice.value = resultText(result)
    error.value = ""
    await load()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 单独重跑装依赖与装后步骤，不重新取源
 *
 * 三种情形要用到：手工放进插件目录的插件（压根没经过安装动作）、装的时候这一步失败过、
 * 以及使用者自己 `git pull` 过而 `dist/` 已旧。
 * @param item 目标条目
 */
async function setup(item: MarketItem): Promise<void> {
  menuOpen.value = ""
  const ok = await askConfirm({
    title: `为「${item.name}」装依赖并编译？`,
    body: "不重新下载插件内容，只在现有目录内装依赖、并按索引声明跑装后步骤。",
    okText: "执行",
    details: [
      "依赖已装好时包管理器会自行跳过，故重复执行是安全的",
      ...setupNotes(item),
      "跑完会重载该插件 —— 编译产物换掉之后，内存里那份旧模块仍在响应命令"
    ]
  })
  if (!ok) return
  busy.value = item.name
  notice.value = ""
  try {
    const result = await post<MarketSetupResult>(`market/${encodeURIComponent(item.name)}/setup`)
    notice.value = setupResultText(result)
    error.value = ""
    await load()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 切换某张卡片的「更多」菜单
 * @param name 插件名
 */
function toggleMenu(name: string): void {
  menuOpen.value = menuOpen.value === name ? "" : name
}

/**
 * 卸载并删除一个插件目录
 * @param item 目标条目
 */
async function remove(item: MarketItem): Promise<void> {
  const ok = await askConfirm({
    title: `删除插件「${item.name}」？`,
    body: "整个安装目录会被移除，无法撤销。",
    okText: "删除",
    danger: true,
    // 配置与数据库不在插件目录内（见内核 market.ts 的 remove()：「配置文件与数据库另行存放，
    // 保留它们使得重新安装后原有配置仍然有效」），故此处不能写「需重新配置」
    details: ["配置文件与数据库另行存放，不会被删除", "重新安装同名插件后，原有配置仍然有效"]
  })
  if (!ok) return
  busy.value = item.name
  try {
    await del(`market/${encodeURIComponent(item.name)}`)
    notice.value = `${item.name} 已删除。`
    error.value = ""
    await load()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

onMounted(() => void load())
</script>

<template>
  <!-- 点空白处关掉展开的菜单，与插件页一致；菜单自身 `@click.stop` 免得点菜单项也关 -->
  <div @click="menuOpen = ''">
    <PageHeader
      route="market"
      sub="从索引安装社区插件。内核默认不携带任何插件，此处与手工放置插件目录等效"
    >
      <template #actions>
        <button :disabled="loading" @click="void load(true)">{{ loading ? "刷新中…" : "刷新索引" }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <div v-if="badSources.length > 0" class="card">
      <h2>索引获取失败</h2>
      <p class="hint">以下索引地址未能获取或解析失败。请检查网络连通性，以及配置项 market.sources 与 market.mirror。</p>
      <ul class="plain">
        <li v-for="s in badSources" :key="s.url">
          <span class="mono">{{ s.url }}</span>
          <span class="err">{{ s.error }}</span>
        </li>
      </ul>
    </div>

    <!-- 横向页签，形制取 `.toolbar.tabs`，与插件页、面板商店同一种 -->
    <div class="toolbar tabs">
      <button
        v-for="item in PAGE_TABS"
        :key="item.id"
        :class="{ primary: tab === item.id }"
        @click="tab = item.id"
      >
        {{ item.label }}
        <span class="tag">{{ counts[item.id] }}</span>
      </button>
    </div>

    <div class="toolbar">
      <input v-model="keyword" type="search" placeholder="按名称、说明或标签筛选" aria-label="筛选插件" />
      <label class="check">
        <input v-model="onlyOfficial" type="checkbox" />
        仅官方维护
      </label>
    </div>

    <p v-if="snapshot" class="hint">
      索引取自 {{ datetime(snapshot.fetchedAt) }}<span v-if="snapshot.cached">（缓存）</span>，共
      {{ items.length }} 个条目，当前显示 {{ visible.length }} 个。
      往面板上添组件的包在<a :href="hrefOf('store')">面板商店</a>，与此处是两份索引。
    </p>

    <div class="grid market">
      <article v-for="item in visible" :key="item.name" class="card item">
        <header>
          <h3>{{ item.title }}</h3>
          <span v-if="item.official" class="tag ok">官方</span>
          <span v-if="item.installed" class="tag">已安装</span>
        </header>
        <p class="mono hint">{{ item.name }}<span v-if="item.version"> · {{ item.version }}</span></p>
        <p>{{ item.description }}</p>
        <p class="hint">
          <span v-if="item.author">作者 {{ item.author }}</span>
          <span v-if="item.minCore"> · 需要内核 {{ item.minCore }} 及以上</span>
        </p>
        <p v-if="item.tags.length > 0" class="tags">
          <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
        </p>
        <footer class="row">
          <button v-if="!item.installed" class="primary" :disabled="busy === item.name" @click="void install(item, false)">
            安装
          </button>
          <button v-else :disabled="busy === item.name" @click="void install(item, true)">更新</button>
          <a v-if="item.installed" class="button" :href="hrefOf('plugins')">配置</a>

          <!--
            更多：装依赖并编译 / 主页 / 删除

            收进菜单而不平铺：已安装的卡片本就有四五个动作，窄卡上必然折行。形制取插件页
            那一个（`.menu` + `.menu-list`），`@click.stop` 拦住冒泡，否则根节点上那个
            「点外面关菜单」会把它当场关掉。
          -->
          <div v-if="item.installed" class="menu" @click.stop>
            <button :aria-expanded="menuOpen === item.name" @click="toggleMenu(item.name)">更多 ▾</button>
            <Transition name="menu">
              <div v-if="menuOpen === item.name" class="menu-list">
                <button :disabled="busy === item.name" @click="void setup(item)">装依赖并编译</button>
                <a
                  v-if="item.homepage"
                  class="button"
                  :href="item.homepage"
                  target="_blank"
                  rel="noreferrer noopener"
                  @click="menuOpen = ''"
                >
                  主页
                </a>
                <button class="danger" :disabled="busy === item.name" @click="void remove(item)">删除</button>
              </div>
            </Transition>
          </div>

          <!-- 未安装的卡片没有菜单，主页那一项直接摆出来 —— 一个动作的菜单只是多一次点击 -->
          <a
            v-if="!item.installed && item.homepage"
            class="button"
            :href="item.homepage"
            target="_blank"
            rel="noreferrer noopener"
          >
            主页
          </a>
        </footer>
      </article>
    </div>

    <p v-if="snapshot && visible.length === 0" class="hint">
      没有符合条件的条目。索引本身共 {{ items.length }} 个插件。
    </p>
  </div>
</template>
