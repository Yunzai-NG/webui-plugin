<script setup lang="ts">
/**
 * 模块职责：面板商店页 —— 浏览面板插件索引，装 / 更 / 删
 * 依赖方向：依赖 api / format / confirm / panelstore / types
 * 生命周期：挂载时读一次索引（允许命中缓存），刷新与写动作后重读
 * 注意事项：**与插件市场页是两页，刻意不合并** —— 索引、落点、安装语义、版本判据四处都不同：
 *          那边是内核插件（`index.json`、内核的 plugins 目录、按 `minCore` 判），这边是面板插件包
 *          （`webui_index.json`、webui 自己的 `plugins/`、按 `minWebui` 判）。
 *
 *          **装完之后该做什么有三种答案**，全由 `storeResultText` 说：只有浏览器侧的包刷新即生效，
 *          带 node 侧的要重载 webui，还缺依赖的要先装依赖。统一说成「已安装」，使用者会刷新页面、
 *          看不到东西、以为装坏了。
 *
 *          **只读模式下写按钮隐去，但那不是门** —— 门在 node 侧（四条写路由各判一次），此处只为不摆
 *          一个点了必报错的按钮。故 `readonly` 取自快照而非本地推断。
 *
 *          **「装依赖」是一个可取消的勾选，且默认勾上**：不装则那个包根本跑不起来。信任边界并未因此
 *          扩大 —— 带 node 侧的包，它的入口下一秒就会被 import 进 node 进程跑 setup()。
 *
 *          **索引取源失败与索引为空分别呈现**（同插件市场页）：前者该查 webui 的 `store.sources` 与
 *          内核的 `market.mirror`，后者是索引本身没有条目。合成一句会让排查方向完全偏离。
 */
import { computed, onMounted, ref } from "vue"
import { delAt, getAt, postAt } from "../api.js"
import { askConfirm } from "../confirm.js"
import { datetime, errorText } from "../format.js"
import {
  STORE_TABS,
  setupNotes,
  storeResultText,
  storeUrlOf,
  tabCounts,
  tagsOf,
  versionText,
  visibleItems,
  willRunPm,
  type StoreTab
} from "../panelstore.js"
import { hrefOf } from "../router.js"
import PageHeader from "../components/PageHeader.vue"
import type { PanelStoreItem, PanelStoreResult, PanelStoreSnapshot } from "../types.js"

const snapshot = ref<PanelStoreSnapshot | undefined>(undefined)
const error = ref("")
const notice = ref("")
const busy = ref("")
const loading = ref(false)
const keyword = ref("")
const tab = ref<StoreTab>("all")
/** 选中的分类；空数组意为不按分类筛 */
const picked = ref<string[]>([])

/** 全部条目 */
const items = computed(() => snapshot.value?.panels ?? [])

/** 索引获取失败的地址 */
const badSources = computed(() => snapshot.value?.sources.filter(source => !source.ok) ?? [])

/** 逐页签的条目数，供角标 */
const counts = computed(() => tabCounts(items.value))

/** 索引里出现过的分类 */
const tags = computed(() => tagsOf(items.value))

/** 按页签、分类与关键词筛过之后的条目 */
const visible = computed(() => visibleItems(items.value, tab.value, picked.value, keyword.value))

/** 是否只读；只读时隐去写按钮 */
const readonly = computed(() => snapshot.value?.readonly === true)

/**
 * 读索引
 * @param refresh 是否强制回源
 */
async function load(refresh = false): Promise<void> {
  loading.value = true
  try {
    snapshot.value = refresh
      ? await postAt<PanelStoreSnapshot>(storeUrlOf("refresh"))
      : await getAt<PanelStoreSnapshot>(storeUrlOf())
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}

/**
 * 切一个分类的选中状态
 * @param tag 分类名
 */
function toggleTag(tag: string): void {
  picked.value = picked.value.includes(tag) ? picked.value.filter(item => item !== tag) : [...picked.value, tag]
}

/**
 * 问一次，并把「装完之后还会自动做什么」逐条写明
 *
 * **两种情形都要跑包管理器**：声明了依赖的包要装依赖；声明了装后步骤的包要跑那几个 script
 * —— 后者即便不声明依赖也得跑，因为产物那一层（`dist/`）多半被包仓库 `.gitignore` 掉了。
 *
 * 逐条写出会跑什么，而不是一句「会自动装依赖」：`build` 要编译、装后步骤可能下载上百兆，
 * 事先不说会让人以为界面卡住了。那也是知情同意的「知情」那一半 —— 但它不是一道新的信任
 * 边界，包的 node 侧入口稍后同样会被 `import()` 执行。
 * @param item 条目
 * @param action 动作名，写进标题
 * @returns 是否继续，以及是否要跑包管理器
 */
async function askDeps(item: PanelStoreItem, action: string): Promise<{ go: boolean; deps: boolean }> {
  const details = [
    `落点：plugins/webui/plugins/${item.name}/`,
    "**「更新 webui」会清空这个目录** —— 那是既定取舍，请对改动过的包留一份备份",
    item.server === true
      ? "这个包带 node 侧，装完须到插件页重载 webui 才会生效"
      : "这个包只有浏览器侧，装完刷新页面即生效",
    ...setupNotes(item)
  ]
  const ok = await askConfirm({
    title: `${action}面板插件「${item.title}」？`,
    body: willRunPm(item)
      ? "从索引取源并装到 webui 的面板插件目录，装完自动装依赖并完成编译。"
      : "从索引取源并装到 webui 的面板插件目录。",
    okText: action,
    details
  })
  // 借 askConfirm 的确认表达同意：确认即同意跑包管理器，取消则整个动作都不做。
  // 另做一个三态对话框（装 / 不装依赖地装 / 取消）在这一处的收益低于它带来的犹豫
  return { go: ok, deps: ok && willRunPm(item) }
}

/**
 * 装一个包
 * @param item 条目
 */
async function install(item: PanelStoreItem): Promise<void> {
  const { go, deps } = await askDeps(item, "安装")
  if (!go) return
  busy.value = item.name
  notice.value = ""
  try {
    const result = await postAt<PanelStoreResult>(storeUrlOf("install"), { name: item.name, dependencies: deps })
    notice.value = storeResultText(result)
    error.value = ""
    await load()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 更一个包
 * @param item 条目
 */
async function update(item: PanelStoreItem): Promise<void> {
  const ok = await askConfirm({
    title: `更新面板插件「${item.title}」？`,
    body: "更新方式由 webui 判定：包目录是 git 仓库且索引声明 git 来源时就地拉取，否则整目录重下。",
    okText: "更新",
    details: [
      `当前：${versionText(item)}`,
      "就地拉取：目录重置到远端最新提交，已装的依赖保留；本地改动自动暂存，可用 git stash pop 取回",
      "退回重装：目录整份替换，含 node_modules —— 那份依赖要重装一遍",
      "两条路都不动这个包的配置 —— 它存在 webui 的数据目录下，不在包目录里",
      ...setupNotes(item)
    ]
  })
  if (!ok) return
  busy.value = item.name
  notice.value = ""
  try {
    // 判据与安装那条路同一个 `willRunPm`：两处各写一遍迟早对不上，而症状是
    // 「装的时候编译了、更新之后没编译」—— 产物停在旧版本，且毫无迹象
    const result = await postAt<PanelStoreResult>(storeUrlOf(`${encodeURIComponent(item.name)}/update`), {
      dependencies: willRunPm(item)
    })
    notice.value = storeResultText(result)
    error.value = ""
    await load()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 删一个包
 * @param item 条目
 */
async function remove(item: PanelStoreItem): Promise<void> {
  const ok = await askConfirm({
    title: `删除面板插件「${item.title}」？`,
    body: "整个包目录会被移除，无法撤销。它贡献的组件会从各页消失。",
    okText: "删除",
    danger: true,
    // 配置存在 webui 的数据目录下，故删包不删配置 —— 与内核 remove() 保留配置同理
    details: ["这个包的配置不会被删除，重装同名包后原有配置仍然有效", "已摆好的版面里，它那几格会变成空位"]
  })
  if (!ok) return
  busy.value = item.name
  try {
    await delAt(storeUrlOf(encodeURIComponent(item.name)))
    notice.value = `${item.name} 已删除。刷新页面后它的组件不再出现。`
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
  <div>
    <PageHeader
      route="store"
      sub="装往面板上添组件的包。与插件市场是两回事 —— 那边装内核插件，这边装面板插件"
    >
      <template #actions>
        <button :disabled="loading" @click="void load(true)">{{ loading ? "刷新中…" : "刷新索引" }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <p v-if="readonly" class="banner">
      面板处于只读模式（配置项 server.readonly 为 true），装 / 更 / 删一律不可用。此页仍可浏览。
    </p>

    <!-- 取源失败与「索引里没有条目」分开呈现，理由见文件头 -->
    <div v-if="badSources.length > 0" class="card">
      <h2>索引获取失败</h2>
      <p class="hint">
        以下地址未能获取或解析失败。请检查网络连通性，以及 webui 配置里的 store.sources
        与内核配置里的 market.mirror —— 镜像前缀两处共用同一项，填在内核那边。
      </p>
      <ul class="plain">
        <li v-for="source in badSources" :key="source.url">
          <span class="mono">{{ source.url }}</span>
          <span class="err">{{ source.error }}</span>
        </li>
      </ul>
    </div>

    <!-- 横向页签，形制取 `.toolbar.tabs`（插件页与帮助页已在用），不新画一种 -->
    <div class="toolbar tabs">
      <button
        v-for="item in STORE_TABS"
        :key="item.id"
        :class="{ primary: tab === item.id }"
        @click="tab = item.id"
      >
        {{ item.label }}
        <span class="tag">{{ counts[item.id] }}</span>
      </button>
    </div>

    <div class="toolbar">
      <input v-model="keyword" type="search" placeholder="按名称、说明或分类筛选" aria-label="筛选面板插件" />
      <!--
        分类做成一排可点的标签而非页签：标签数由索引决定，十几个页签在窄屏上必然折行，
        而折行会把上面那三个主页签挤到第二行去
      -->
      <span v-for="item in tags" :key="item" class="tag pick" :class="{ on: picked.includes(item) }" @click="toggleTag(item)">
        {{ item }}
      </span>
      <button v-if="picked.length > 0" @click="picked = []">清空分类</button>
    </div>

    <p v-if="snapshot" class="hint">
      索引取自 {{ datetime(snapshot.fetchedAt) }}<span v-if="snapshot.cached">（缓存）</span>，共
      {{ items.length }} 个条目，当前显示 {{ visible.length }} 个。
    </p>

    <div class="grid market">
      <article v-for="item in visible" :key="item.name" class="card item">
        <header>
          <h3>{{ item.title }}</h3>
          <span v-if="item.official" class="tag ok">官方</span>
          <span v-if="item.updatable" class="tag warn">可更新</span>
          <span v-else-if="item.installed" class="tag">已安装</span>
        </header>

        <p class="mono hint">{{ item.name }} · {{ versionText(item) }}</p>
        <p>{{ item.description }}</p>

        <p class="hint">
          <span v-if="item.author">作者 {{ item.author }}</span>
          <span v-if="item.minWebui"> · 需要面板 {{ item.minWebui }} 及以上</span>
          <!-- 组件数是索引作者填的预告，真实数目要 import 过才知道，故写「约」 -->
          <span v-if="item.widgets !== undefined"> · 约 {{ item.widgets }} 枚组件</span>
          <span v-if="item.server"> · 带 node 侧</span>
        </p>

        <p v-if="item.tags.length > 0" class="tags">
          <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
        </p>

        <footer class="row">
          <template v-if="!readonly">
            <button v-if="!item.installed" class="primary" :disabled="busy === item.name" @click="void install(item)">
              安装
            </button>
            <button
              v-else
              :class="{ primary: item.updatable }"
              :disabled="busy === item.name"
              @click="void update(item)"
            >
              更新
            </button>
            <a v-if="item.installed" class="button" :href="hrefOf('plugins')">在插件页查看</a>
            <button v-if="item.installed" class="danger" :disabled="busy === item.name" @click="void remove(item)">
              删除
            </button>
          </template>
          <a v-else-if="item.installed" class="button" :href="hrefOf('plugins')">在插件页查看</a>
          <a v-if="item.homepage" class="button" :href="item.homepage" target="_blank" rel="noreferrer noopener">
            主页
          </a>
        </footer>
      </article>
    </div>

    <p v-if="snapshot && visible.length === 0 && items.length > 0" class="hint">
      没有符合条件的条目。索引本身共 {{ items.length }} 个面板插件。
    </p>
    <p v-if="snapshot && items.length === 0 && badSources.length === 0" class="card hint">
      索引里还没有面板插件条目。
    </p>

    <p class="hint">
      面板插件装进 <code>plugins/webui/plugins/</code>，该目录会被「更新 webui」清空，请对改动过的包留一份备份。
      商店只装「包」形态（一个目录 + <code>index.js</code> + <code>package.json</code>）——
      单文件的 <code>.js</code> 手放仍可用，但它的版本号 node 侧读不到，无从判断该不该更新。
    </p>
  </div>
</template>
