<script setup lang="ts">
/**
 * 模块职责：插件市场页 —— 浏览索引、安装插件
 * 依赖方向：依赖 api / format / filter / router / types
 * 生命周期：挂载时读取一次索引（允许命中缓存），刷新与安装后重新读取
 * 注意事项：**这一页只管「浏览」与「装」，不管「管」。** 更新、重装、装依赖、跑编译、卸载与删除
 *          一律在插件页 —— 那里列的是「我装了什么」，管理动作的上下文在那张卡片上。装完之后这里
 *          只留一个「在插件页查看」。两处都摆一套管理动作的代价不是重复，而是使用者得先猜「该去
 *          哪一页更新」，而两页的按钮还可能不一样多。
 *
 *          **默认读缓存，刷新是显式动作**（生存期由 `market.cacheTtl` 定）—— 索引不会在分钟级变化，
 *          每次进页面都回源只会让打开速度取决于网络。
 *
 *          **取源失败与索引里没有条目分开呈现**：前者查 `market.sources` 与 `market.mirror`，
 *          后者是索引本身为空。合成一句「没有可用插件」会让排查方向完全偏离。
 *
 *          安装的确认框须把「会执行什么」写明：装依赖等于执行该插件依赖的 install 脚本，而装后步骤
 *          是索引声明的 npm script。那是知情同意的「知情」那一半 —— 但它不是一道新的信任边界，
 *          插件入口下一秒就会被内核 `import()` 执行。
 *
 *          **说明限两行、溢出省略**：一个写了三百字说明的条目会把它那一行的卡片全部拉高。全文在
 *          「查看」里 —— 那个模态同时是「作者、版本、来源索引」这些卡片上摆不下的事实的去处。
 */
import { computed, onMounted, ref } from "vue"
import { get, post } from "../api.js"
import { datetime, errorText } from "../format.js"
import { askConfirm } from "../confirm.js"
import { MARKET_TABS, tagsOf, toggleTag, visibleItems, tabCounts, type MarketTab } from "../filter.js"
import { resultText } from "../market.js"
import { hrefOf } from "../router.js"
import Modal from "../components/Modal.vue"
import PageHeader from "../components/PageHeader.vue"
import type { MarketInstallResult, MarketItem, MarketSnapshot } from "../types.js"

const snapshot = ref<MarketSnapshot | undefined>(undefined)
const error = ref("")
const notice = ref("")
const busy = ref("")
const loading = ref(false)
const keyword = ref("")
const onlyOfficial = ref(false)
/** 当前页签 */
const tab = ref<MarketTab>("all")
/** 选中的分类；空数组意为不按分类筛 */
const picked = ref<string[]>([])
/** 正在看哪个条目的详情；空串意为详情模态未开 */
const viewing = ref("")

/** 索引获取失败的地址 */
const badSources = computed(() => snapshot.value?.sources.filter(s => !s.ok) ?? [])

/** 全部条目 */
const items = computed(() => snapshot.value?.plugins ?? [])

/** 索引里出现过的分类 */
const tags = computed(() => tagsOf(items.value))

/** 逐页签的条目数，供角标 */
const counts = computed(() => tabCounts(items.value))

/** 正在看的那个条目 */
const viewed = computed(() => items.value.find(item => item.name === viewing.value))

/**
 * 按页签、分类、关键词与官方标记过滤后的条目
 *
 * 前三道判据取自 `filter.ts`，与面板商店共用；「仅官方」是这一页独有的一道，故留在此处。
 */
const visible = computed(() =>
  visibleItems(items.value, tab.value, picked.value, keyword.value).filter(
    item => !onlyOfficial.value || item.official
  )
)

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
 * 「装完之后还会做什么」那几句
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
 * 安装一个插件
 *
 * **只有安装，没有更新** —— 更新在插件页。那一条要问「本地改动是否暂存」，而那个问题
 * 只有对着「已装的这一份」才问得出来。
 * @param item 目标条目
 */
async function install(item: MarketItem): Promise<void> {
  const ok = await askConfirm({
    title: `安装插件「${item.title}」？`,
    body: "从索引取源并装到内核的插件目录，装完自动装依赖并按索引声明完成编译。",
    okText: "安装",
    details: [`落点：plugins/${item.name}/`, ...setupNotes(item)]
  })
  if (!ok) return
  busy.value = item.name
  notice.value = ""
  try {
    const result = await post<MarketInstallResult>("market/install", { name: item.name })
    notice.value = resultText(result)
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
      route="market"
      sub="从索引安装社区插件。装完之后的更新、重装与卸载在插件页"
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
        v-for="item in MARKET_TABS"
        :key="item.id"
        :class="{ primary: tab === item.id }"
        @click="tab = item.id"
      >
        {{ item.label }}
        <span class="tag">{{ counts[item.id] }}</span>
      </button>
    </div>

    <Transition name="tab" mode="out-in">
    <div :key="tab">
    <div class="toolbar">
      <input v-model="keyword" type="search" placeholder="按名称、说明或标签筛选" aria-label="筛选插件" />
      <label class="check">
        <input v-model="onlyOfficial" type="checkbox" />
        <span class="checkmark"></span>
        仅官方维护
      </label>
      <!--
        分类做成一排可点的标签而非页签（同面板商店）：标签数由索引决定，十几个页签在窄屏上
        必然折行，而折行会把上面那三个主页签挤到第二行去
      -->
      <span
        v-for="item in tags"
        :key="item"
        class="tag pick"
        :class="{ on: picked.includes(item) }"
        @click="picked = toggleTag(picked, item)"
      >
        {{ item }}
      </span>
      <button v-if="picked.length > 0" @click="picked = []">清空分类</button>
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
          <span v-if="item.updatable" class="tag warn">可更新</span>
          <span v-else-if="item.installed" class="tag">已安装</span>
        </header>
        <!-- 已装且可更新时给「旧 → 新」：只给一个数看不出该不该更新 -->
        <p class="mono hint">
          {{ item.name }}<span v-if="item.updatable"> · {{ item.installedVersion }} → {{ item.version }}</span
          ><span v-else-if="item.installedVersion"> · {{ item.installedVersion }}</span
          ><span v-else-if="item.version"> · {{ item.version }}</span>
        </p>
        <p class="plugin-desc">{{ item.description }}</p>
        <p class="hint">
          <span v-if="item.author">作者 {{ item.author }}</span>
          <span v-if="item.minCore"> · 需要内核 {{ item.minCore }} 及以上</span>
        </p>
        <p v-if="item.tags.length > 0" class="tags">
          <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
        </p>
        <footer class="row">
          <button v-if="!item.installed" class="primary" :disabled="busy === item.name" @click="void install(item)">
            安装
          </button>
          <!--
            装完只留一个去处，管理动作全在插件页

            更新、重装、装依赖、卸载与删除都在那边。这里再摆一套，使用者得先猜该去哪一页。
          -->
          <a v-else class="button" :href="hrefOf('plugins')">在插件页查看</a>
          <button @click="viewing = item.name">查看</button>
          <a
            v-if="item.homepage"
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
    </Transition>

    <!--
      查看：卡片上摆不下的那些事实，以及被截成两行的说明的全文

      不做成页签：这里只有一组事实，一个页签栏只会多一次点击。
    -->
    <Modal
      :open="viewing !== ''"
      wide
      :title="`插件「${viewed?.title ?? ''}」`"
      @close="viewing = ''"
    >
      <template v-if="viewed">
        <p>{{ viewed.description }}</p>
        <dl class="facts">
          <dt>插件名</dt>
          <dd class="mono">{{ viewed.name }}</dd>
          <dt>索引声明的版本</dt>
          <dd class="mono">{{ viewed.version ?? "未声明" }}</dd>
          <dt v-if="viewed.installed">已装的版本</dt>
          <dd v-if="viewed.installed" class="mono">
            {{ viewed.installedVersion ?? "读不到 —— 该目录没有 package.json，或它没写 version" }}
          </dd>
          <dt v-if="viewed.author">作者</dt>
          <dd v-if="viewed.author">{{ viewed.author }}</dd>
          <dt v-if="viewed.minCore">最低内核版本</dt>
          <dd v-if="viewed.minCore" class="mono">{{ viewed.minCore }}</dd>
          <dt>分类</dt>
          <dd>{{ viewed.tags.length === 0 ? "未声明" : viewed.tags.join("、") }}</dd>
          <dt>装后步骤</dt>
          <dd>
            <span v-if="(viewed.setup?.scripts.length ?? 0) > 0" class="mono">
              {{ viewed.setup?.scripts.join("、") }}
            </span>
            <span v-else>无 —— 装完依赖就算完</span>
          </dd>
          <dt>来源索引</dt>
          <dd class="mono">{{ viewed.source }}</dd>
          <dt v-if="viewed.homepage">主页</dt>
          <dd v-if="viewed.homepage">
            <a :href="viewed.homepage" target="_blank" rel="noreferrer noopener">{{ viewed.homepage }}</a>
          </dd>
        </dl>
        <p v-if="viewed.installed" class="hint">
          这个插件已经装上了。更新、重装、装依赖与卸载在<a :href="hrefOf('plugins')">插件页</a>。
        </p>
      </template>
    </Modal>
  </div>
</template>
