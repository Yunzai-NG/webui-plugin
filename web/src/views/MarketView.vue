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
import { del, get, post } from "../api.js"
import { datetime, errorText } from "../format.js"
import { askConfirm } from "../confirm.js"
import { MARKET_TABS, emptyCriteria, gatesOf, visibleItems, tabCounts, type Criteria } from "../filter.js"
import { resultText } from "../market.js"
import { hrefOf } from "../router.js"
import MarketFilter from "../components/MarketFilter.vue"
import Modal from "../components/Modal.vue"
import PageHeader from "../components/PageHeader.vue"
import type { MarketInstallResult, MarketItem, MarketSnapshot, Overview } from "../types.js"

const snapshot = ref<MarketSnapshot | undefined>(undefined)
const error = ref("")
const notice = ref("")
const busy = ref("")
const loading = ref(false)
/**
 * 六维筛选判据，整份交给 `MarketFilter`
 *
 * 从前是 `keyword` / `onlyOfficial` / `tab` / `picked` 四个各自独立的 ref。收成一个对象
 * 之后「清空全部」只是赋一份 `emptyCriteria()`，不必逐个记得复位 —— 漏掉一个的表现是
 * 「点了清空，条目数却没变回去」。
 */
const criteria = ref<Criteria>(emptyCriteria())
/** 正在看哪个条目的详情；空串意为详情模态未开 */
const viewing = ref("")

/**
 * 当前内核版本，供版本门那一维的「装得上的」一项
 *
 * 单取一次而非跟着节拍刷：内核版本在一次运行里不会变。取不到时那一项整个不出现，
 * 而不是拿一个空串去比 —— 见 `matchesGate`。
 */
const coreVersion = ref("")

/** 索引获取失败的地址 */
const badSources = computed(() => snapshot.value?.sources.filter(s => !s.ok) ?? [])

/** 全部条目 */
const items = computed(() => snapshot.value?.plugins ?? [])

/** 索引里声明过的最低内核版本，升序去重 */
const gates = computed(() => gatesOf(items.value, item => item.minCore))

/** 逐页签的条目数，供角标 */
const counts = computed(() => tabCounts(items.value))

/** 正在看的那个条目 */
const viewed = computed(() => items.value.find(item => item.name === viewing.value))

/**
 * 按六维判据过滤后的条目
 *
 * 判据本身与面板商店共用（`filter.ts`），只有两样是这一页的：版本门读的是 `minCore`
 * （商店那边是 `minWebui`），当前版本是内核版本。故这两样以 `ctx` 传入，而不是让
 * 纯函数去认字段名。
 */
const visible = computed(() =>
  visibleItems(items.value, criteria.value, {
    gateOf: item => item.minCore,
    ...(coreVersion.value === "" ? {} : { current: coreVersion.value })
  })
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

/**
 * 取一次内核版本
 *
 * **失败时静默**：这个数只供版本门里「装得上的」那一项，取不到时那一项不出现即可 ——
 * 为它在页面顶上挂一条红条会让人以为市场坏了，而插件列表明明好着。
 * @returns 取完即结束
 */
async function loadVersion(): Promise<void> {
  try {
    coreVersion.value = (await get<Overview>("overview")).version
  } catch {
    coreVersion.value = ""
  }
}

/* ────────────────────── 自定义安装 ────────────────────── */

/**
 * 自定义安装的表单
 *
 * 只有 `url` 必填，其余各项都能推出或留空 —— 一个要填七格才能装一个插件的表单，
 * 与自己去 `git clone` 相比没有便利可言。
 */
const form = ref({ url: "", name: "", branch: "", build: false, scripts: "", title: "", description: "" })

/** 自定义安装的模态是否开着 */
const adding = ref(false)

/** 正在装（那一趟可能要几分钟，期间按钮要锁住） */
const installing = ref(false)

/**
 * 额外脚本按逗号或空白切开
 *
 * 让使用者填一行 `install:browser, build:docs` 而不是逐个加输入框。空白项滤掉 ——
 * 末尾多打一个逗号是常事，而一个空的 script 名会被内核判为不合法而整次失败。
 */
const extraScripts = computed(() =>
  form.value.scripts
    .split(/[,，\s]+/)
    .map(one => one.trim())
    .filter(one => one !== "")
)

/** 表单填得够不够发出去 */
const canSubmit = computed(() => form.value.url.trim() !== "" && !installing.value)

/**
 * 开一个空表单
 *
 * **每次都从空白开始**，不留上一次填的东西：上一次多半已经装成了，留着那份地址只会
 * 让人以为「点了安装却没反应」（实则撞在「已安装」上）。
 */
function openAdd(): void {
  form.value = { url: "", name: "", branch: "", build: false, scripts: "", title: "", description: "" }
  adding.value = true
}

/**
 * 登记并安装一个自定义插件
 *
 * 确认框里那几句写得比索引安装更重：索引好歹是一份经审核的清单，而这里的地址是使用者
 * 当场填的 —— 填错或填了个恶意仓库，后果是在这台机器上执行任意代码。这道信任边界
 * 正是这个功能打开的，故不能只说「装完会跑 pnpm install」。
 */
async function submitCustom(): Promise<void> {
  const url = form.value.url.trim()
  if (url === "") return

  const steps = ["装完会在插件目录内执行 pnpm install（找不到 pnpm 时退回 npm）"]
  if (form.value.build) steps.push("随后执行 build 编译")
  if (extraScripts.value.length > 0) steps.push(`随后依次执行 ${extraScripts.value.join("、")}`)

  const ok = await askConfirm({
    title: "从这个地址安装插件？",
    body:
      "这个地址不来自任何索引，没有经过审核。仓库里的代码装完即被内核 import() 执行，" +
      "其 install 脚本与装后步骤同样在这台机器上运行 —— 请确认你信任它。",
    okText: "我确认，安装",
    danger: true,
    details: [`仓库：${url}`, `落点：plugins/${form.value.name.trim() === "" ? "（由地址推出）" : form.value.name.trim()}/`, ...steps]
  })
  if (!ok) return

  installing.value = true
  notice.value = ""
  try {
    const result = await post<MarketInstallResult>("market/custom", {
      url,
      // 空串一律不发：内核那侧「没给这一项」与「给了个空串」判据不同，前者才走推导
      ...(form.value.name.trim() === "" ? {} : { name: form.value.name.trim() }),
      ...(form.value.branch.trim() === "" ? {} : { branch: form.value.branch.trim() }),
      ...(form.value.title.trim() === "" ? {} : { title: form.value.title.trim() }),
      ...(form.value.description.trim() === "" ? {} : { description: form.value.description.trim() }),
      build: form.value.build,
      scripts: extraScripts.value
    })
    notice.value = resultText(result)
    error.value = ""
    adding.value = false
    await load()
  } catch (err) {
    // 不关模态：报错多半是地址或目录名要改，关掉就得重填一遍
    error.value = errorText(err)
  } finally {
    installing.value = false
  }
}

/**
 * 撤掉一条自定义登记
 *
 * **不删插件目录**，故与「卸载」是两件事。撤掉之后这个插件仍在磁盘上、仍会被加载，
 * 只是不再显示在市场里、也不再能从这里更新 —— 确认框里要把这一点说清。
 * @param item 目标条目
 */
async function dropCustom(item: MarketItem): Promise<void> {
  const ok = await askConfirm({
    title: `撤掉「${item.title}」的登记？`,
    body: "只撤掉这条登记，不动插件目录。撤掉后它不再显示在市场里，也不能再从这里更新。",
    okText: "撤掉登记",
    details: [
      `插件目录 plugins/${item.name}/ 保持原样，插件照常加载`,
      ...(item.installed ? ["要连目录一起删，请去插件页卸载"] : [])
    ]
  })
  if (!ok) return
  busy.value = item.name
  notice.value = ""
  try {
    await del(`market/custom/${encodeURIComponent(item.name)}`)
    notice.value = `已撤掉 ${item.name} 的登记，插件目录未动。`
    error.value = ""
    await load()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

onMounted(() => {
  void load()
  void loadVersion()
})
</script>

<template>
  <div>
    <PageHeader
      route="market"
      sub="从索引安装社区插件。装完之后的更新、重装与卸载在插件页"
    >
      <template #actions>
        <!--
          自定义安装摆在「刷新索引」左边

          它是这一页上唯一会写磁盘的入口，比刷新重要；而刷新是个随手动作，
          放在右边不碍事。
        -->
        <button class="primary" @click="openAdd()">自定义安装</button>
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
        :class="{ primary: (criteria.tab ?? 'all') === item.id }"
        @click="criteria = { ...criteria, tab: item.id }"
      >
        {{ item.label }}
        <span class="tag">{{ counts[item.id] }}</span>
      </button>
    </div>

    <Transition name="tab" mode="out-in">
    <div :key="criteria.tab ?? 'all'">
    <!--
      六维筛选收进可展开面板，与面板商店同一个组件

      分类那一排从前常驻在此处，七个条目就占掉两行、把首屏卡片压下去一截。
    -->
    <MarketFilter
      v-model="criteria"
      :items="items"
      :gates="gates"
      gate-label="内核"
      :current="coreVersion"
      placeholder="按名称、说明或标签筛选"
      search-label="筛选插件"
    />

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
          <!--
            自定义那枚标记不可省：这一条的来历与旁边几条不同

            索引条目背后有一份经审核的清单，这一条只有使用者当时填的地址。两者在卡片上
            长得一样的话，「这个插件打哪来的」就答不出来了 —— 而那正是出问题时第一个要问的。
          -->
          <span v-if="item.custom" class="tag info">自定义</span>
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
          <!--
            撤登记只对自登记的那几条出现，且**不取 danger 形制**

            它不删任何东西（插件目录一字不动），故与「卸载」不是同一类动作。给它红色会让人
            以为点下去要丢东西，而真正会丢东西的那个按钮在插件页。
          -->
          <button v-if="item.custom" :disabled="busy === item.name" @click="void dropCustom(item)">
            撤销登记
          </button>
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
          <!--
            自定义条目的 `source` 是内部标记（`custom`），照搬到这里等于让人去猜

            这一行要答的是「这条打哪来的」。自定义条目该答的是那个仓库地址 —— 那正是
            出问题时唯一有用的事实，而「custom」四个字母什么都没说。
          -->
          <dt>{{ viewed.custom ? "来源" : "来源索引" }}</dt>
          <dd class="mono">{{ viewed.custom ? viewed.install?.url ?? "自定义安装" : viewed.source }}</dd>
          <dt v-if="viewed.custom">登记</dt>
          <dd v-if="viewed.custom">
            这一条由你自己登记，不来自任何索引，故没有经过审核。撤掉登记不会删插件目录。
          </dd>
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

    <!--
      自定义安装：填一个 git 地址即可，其余各项都能推出或留空

      **只有地址一项必填。** 一个要填七格才能装一个插件的表单，与自己去 `git clone`
      相比没有便利可言，故其余六项都给了缺省行为，并在各自的占位文案里写明那个缺省是什么。

      两项写在最前：地址与目录名。它们是唯一会让整次安装失败的两项（地址不通、目录名
      撞了已有目录），其余各项填错最多是装完少跑一个脚本，可以再来一次。
    -->
    <Modal :open="adding" wide title="从 git 地址安装插件" @close="adding = false">
      <p class="hint">
        这个地址不来自任何索引，没有经过审核。仓库里的代码装完即被内核 import() 执行，
        其 install 脚本与装后步骤同样在这台机器上运行 —— 请只填你信任的仓库。
      </p>

      <div class="field">
        <label for="cu-url">git 仓库地址</label>
        <input
          id="cu-url"
          v-model="form.url"
          placeholder="https://github.com/作者/仓库名"
          autocomplete="off"
          spellcheck="false"
        />
        <p class="hint">须以 http:// 或 https:// 开头。SSH 形式（git@…）用不了，那要本机配好密钥。</p>
      </div>

      <div class="field">
        <label for="cu-name">安装目录名</label>
        <input id="cu-name" v-model="form.name" placeholder="选填，缺省取仓库名" autocomplete="off" spellcheck="false" />
        <p class="hint">
          它同时是插件目录名与配置文件名。与已有插件撞名时安装会失败，那时换一个名字即可。
        </p>
      </div>

      <div class="field">
        <label for="cu-branch">分支</label>
        <input id="cu-branch" v-model="form.branch" placeholder="选填，缺省由远端决定" autocomplete="off" />
      </div>

      <div class="field">
        <label class="check">
          <input v-model="form.build" type="checkbox" />
          <span class="checkmark"></span>
          需要编译
        </label>
        <p class="hint">
          勾上即在装完依赖后执行 build。TypeScript 写的插件多半需要它 —— 仓库里通常不含
          编译产物，而缺产物时加载报的是「找不到模块」。
        </p>
      </div>

      <div class="field">
        <label for="cu-scripts">额外要跑的脚本</label>
        <input
          id="cu-scripts"
          v-model="form.scripts"
          placeholder="选填，多个用逗号或空格分隔，如 install:browser"
          autocomplete="off"
          spellcheck="false"
        />
        <p class="hint">
          按填写顺序在 build 之后依次执行。渲染器那类要下载浏览器的插件用得上，那一步可达数分钟。
        </p>
      </div>

      <div class="field">
        <label for="cu-title">显示名称</label>
        <input id="cu-title" v-model="form.title" placeholder="选填，缺省取目录名" autocomplete="off" />
      </div>

      <div class="field">
        <label for="cu-desc">说明</label>
        <input id="cu-desc" v-model="form.description" placeholder="选填，只影响这张卡片上的一行字" autocomplete="off" />
      </div>

      <template #actions>
        <button :disabled="installing" @click="adding = false">取消</button>
        <button class="primary" :disabled="!canSubmit" @click="void submitCustom()">
          {{ installing ? "安装中…" : "登记并安装" }}
        </button>
      </template>
    </Modal>
  </div>
</template>
