<script setup lang="ts">
/**
 * 模块职责：应用外壳 —— 令牌闸门、分组导航、页面切换
 * 依赖方向：依赖 api / router / 各视图
 * 生命周期：整个页面
 * 注意事项：**先探一次 `GET overview` 再决定渲染什么** —— 服务端有两种合法姿态（仅监听本机且未设令牌、
 *          或已设令牌），前端无法由配置推断是哪一种；而这次请求的结果本就是概览页要的数据。
 *
 *          令牌错误时不清除已保存的令牌：使用者可能只是内核换了令牌，保留旧值便于改个别字符。
 *
 *          页面切换用 `v-if` 而非 `v-show`：日志页靠 `onUnmounted` 关 WebSocket，`v-show` 会让它在后台持续收数据。
 *
 *          **抽屉与折叠是两件事，不共用状态**：抽屉只在窄屏有意义，折叠只在宽屏有意义。合并成一个状态会让
 *          「窄屏点开抽屉」在切到宽屏后表现为侧栏被折起。折叠态的样式一律写在 `min-width: 860px` 之内。
 *
 *          **底部的连接状态由一条独立心跳维持**（闸门那次探测只说明进入面板那一刻内核是活的）。心跳失败
 *          **不退回闸门** —— 那会连带丢掉使用者正在读的内容；唯一的例外是 401/403，那时留在外壳里做什么都不会成功。
 */
import { computed, onMounted, onUnmounted, ref, watch, type Component } from "vue"
import { get, getAt, getToken, post, setToken } from "./api.js"
import { ApiError } from "./api.js"
import { errorText } from "./format.js"
import { ROUTES, currentQuery, currentRoute, hrefOf, type RouteDef } from "./router.js"
import { THEME_LABEL, cycleTheme, themeChoice, type ThemeChoice } from "./theme.js"
import type { Overview } from "./types.js"
import AppIcon from "./components/AppIcon.vue"
import CustomPageIcon from "./components/CustomPageIcon.vue"
import ConfirmDialog from "./components/ConfirmDialog.vue"
import PathPicker from "./components/PathPicker.vue"
import OverviewView from "./views/OverviewView.vue"
import AccountsView from "./views/AccountsView.vue"
import PluginsView from "./views/PluginsView.vue"
import MarketView from "./views/MarketView.vue"
import StoreView from "./views/StoreView.vue"
import ConfigView from "./views/ConfigView.vue"
import LogsView from "./views/LogsView.vue"
import HelpView from "./views/HelpView.vue"
import AppearanceView from "./views/AppearanceView.vue"
import CustomPageView from "./views/CustomPageView.vue"

/**
 * 一个插件挂上来的页面，字段与服务端 `custompage.ts` 的 `CustomPage` 对齐
 *
 * `id` 即插件目录名，由服务端担保全局唯一 —— 故此处按 `id` 作 `:key` 与选中判据都是安全的。
 */
interface MountedPage {
  id: string
  title: string
  /** emoji 或插件图片数据 */
  icon?: string
  /** 提供者显示名，二级项的 `title` 提示据它说明出处 */
  provider: string
}

/**
 * 心跳间隔
 *
 * 取 30 秒而非概览页的 5 秒：这一条只为侧栏的连接标记服务，晚半分钟知道并无妨碍，
 * 而每 5 秒一次的额外请求会一直持续到关页。
 */
const BEAT_MS = 30_000

/** 侧栏折叠态在 localStorage 中的键，与令牌同前缀 */
const COLLAPSE_KEY = "yunzai-ng.sidebar-collapsed"

/** 品牌图标，与 index.html 的 favicon 同一个文件 */
const MARK = "icon-square.svg"

/** 清除令牌一项的图标：一支向右的箭头，读作「离开」 */
const SIGN_OUT = "M13 6l6 6-6 6M19 12H5"

/*
 * 扩展页面一组的三个图标
 *
 * 一律走 svg path 而非 `⌃` `⌄` `🦊` 一类字符：前两个是 Unicode 几何字符，Windows 上被系统
 * 彩色字体接管后 `color` 失效，折叠态下与描边图标并列会明显不同色；后一个是彩色字形，
 * 在深色主题里无从跟着变。理由与 `router.ts` 的 `RouteDef.icon` 同一条。
 */
/** 展开态的折角：一枚朝上的角标 */
const CARET_UP = "M7 14l5-5 5 5"
/** 收起态的折角：一枚朝下的角标 */
const CARET_DOWN = "M7 10l5 5 5-5"
/** 二级项的项目符号：一个小圆，读作「这一组下的一项」 */
const PAGE_DOT = "M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3"

/**
 * 主题一项的三个图标，与 `ThemeChoice` 一一对应
 *
 * 三态各有各的图形，不共用一个「主题」图标：共用之后按钮上就只剩文案在变，
 * 而折叠态的侧栏只有 72px、文案是隐去的，那时使用者无从知道当前是哪一态。
 */
const THEME_ICON: Record<ThemeChoice, string> = {
  // 半明半暗的圆：跟随系统
  auto: "M12 3a9 9 0 000 18zM12 3a9 9 0 010 18",
  // 太阳
  light: "M12 5.5v-2M12 20.5v-2M5.5 12h-2M20.5 12h-2M7.4 7.4L6 6M18 18l-1.4-1.4M16.6 7.4L18 6M6 18l1.4-1.4M15.5 12a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0",
  // 月亮
  dark: "M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"
}

/**
 * 路由标识 → 视图组件
 *
 * 一张表加 `<component :is>` 而非一串 `v-if`：后者无法包进 `<Transition>`（过渡要求单一子节点）。
 * `:key` 使切换仍走完整的卸载与挂载 —— 日志页靠 `onUnmounted` 关 WebSocket，这一条不可退化。
 */
const VIEWS: Record<string, Component> = {
  overview: OverviewView,
  accounts: AccountsView,
  logs: LogsView,
  plugins: PluginsView,
  market: MarketView,
  store: StoreView,
  config: ConfigView,
  help: HelpView,
  appearance: AppearanceView,
  custom: CustomPageView
}

/** 闸门状态 */
const state = ref<"checking" | "locked" | "open" | "down">("checking")
const draftToken = ref(getToken())
const message = ref("")
const version = ref("")
/** 窄屏抽屉是否展开 */
const drawer = ref(false)
/** 宽屏侧栏是否折叠为窄条 */
const collapsed = ref(localStorage.getItem(COLLAPSE_KEY) === "1")
/** 最近一次请求内核是否成功 */
const online = ref(true)
/** 内核是否处于只读模式 */
const readonly = ref(false)
const mountedPages = ref<MountedPage[]>([])
const customExpanded = ref(true)
/**
 * 「发送到日志」这一枚的即时反馈
 *
 * 那个动作的结果落在**别处**（终端或日志文件），页面上什么都不会变 —— 不给一句回执的话，
 * 使用者只能反复点它，而每次点都往日志里多写一行。
 */
const revealNote = ref("")
const revealing = ref(false)

let beat: number | undefined

/** 按 `group` 归并后的导航，组内与组间顺序均沿用 ROUTES 的声明顺序 */
const groups = computed(() => {
  const out: Array<{ title: string; routes: RouteDef[] }> = []
  for (const route of ROUTES) {
    const last = out[out.length - 1]
    if (last !== undefined && last.title === route.group) last.routes.push(route)
    else out.push({ title: route.group, routes: [route] })
  }
  return out
})

/** 当前视图组件；标识未登记时退回概览，与 `router.ts` 的 `parseHash` 取同一取舍 */
const view = computed<Component>(() => VIEWS[currentRoute.value] ?? OverviewView)

/** 切换折叠态并落盘 */
function toggleCollapse(): void {
  collapsed.value = !collapsed.value
  if (collapsed.value) localStorage.setItem(COLLAPSE_KEY, "1")
  else localStorage.removeItem(COLLAPSE_KEY)
}

/** 探测一次，判断是否需要令牌 */
async function probe(): Promise<void> {
  state.value = "checking"
  try {
    const overview = await get<Overview>("overview")
    version.value = overview.version
    readonly.value = overview.server.readonly
    online.value = true
    state.value = "open"
    message.value = ""
    await loadMountedPages()
  } catch (err) {
    if (err instanceof ApiError && err.isAuth) {
      state.value = "locked"
      message.value = err.message
      return
    }
    // 「无法连接内核」与「内核返回 500」须分别陈述：前者需检查进程是否运行，
    // 后者需查看日志。合并为一句「加载失败」将使两个方向都无从排查
    state.value = "down"
    message.value = errorText(err)
  }
}

/**
 * 取一次已挂载的插件页面清单
 *
 * 失败一律退回空数组而不报错：没有任何插件装页面时，导航里就该干净地少一截二级项，
 * 而不是在侧栏上挂一条使用者无从处置的错误。
 */
async function loadMountedPages(): Promise<void> {
  try {
    mountedPages.value = (await getAt<{ pages?: MountedPage[] }>("/plugin/webui/custom-pages")).pages ?? []
  } catch {
    mountedPages.value = []
  }
}

/** 心跳一次：只更新连接标记与只读标记，不改动闸门状态（例外见文件头） */
async function tick(): Promise<void> {
  try {
    const overview = await get<Overview>("overview")
    version.value = overview.version
    readonly.value = overview.server.readonly
    online.value = true
  } catch (err) {
    if (err instanceof ApiError && err.isAuth) {
      state.value = "locked"
      message.value = err.message
      return
    }
    online.value = false
  }
}

/** 保存令牌并重试 */
async function submitToken(): Promise<void> {
  setToken(draftToken.value)
  await probe()
}

/**
 * 请内核把当前令牌打进日志
 *
 * **不显示到界面上，只写日志。** 这个端点是 `auth: false` 的（需要它的人恰恰是没有令牌的
 * 那个人，带令牌才能调等于没有这个功能），故它的响应一个字节都不带令牌 —— 否则使用者
 * 浏览器里的任何页面都能取到面板的全部写权限。看令牌请去终端或日志文件。
 */
async function revealToken(): Promise<void> {
  revealing.value = true
  try {
    const done = await post<{ hasToken?: boolean }>("token/reveal")
    revealNote.value =
      done.hasToken === false
        ? "当前未设置访问令牌 —— 此时留空即可进入"
        : "已打进日志，请到运行内核的终端（或日志文件）查看"
  } catch (err) {
    revealNote.value = errorText(err)
  } finally {
    revealing.value = false
  }
}

/** 清除令牌并返回闸门 */
function signOut(): void {
  setToken("")
  draftToken.value = ""
  state.value = "locked"
  message.value = "已清除本机保存的令牌"
}

watch(currentRoute, id => {
  drawer.value = false
  if (id !== "custom") return
  // 进扩展页面时重取一次清单：装插件、重载 webui 都会改变它，而使用者刚做完这些事
  // 第一件想确认的就是「我那一页出来了没有」，此时要求他刷新整页是多余的一步
  void loadMountedPages()
  // 一并展开：此前收起过的话，直接开一个带 `?name=` 的链接会看不到自己正停在哪一页 ——
  // 右侧显示着某个插件的页面，左侧那一组却是收着的
  customExpanded.value = true
})

onMounted(() => {
  void probe()
  beat = window.setInterval(() => void tick(), BEAT_MS)
})

onUnmounted(() => {
  if (beat !== undefined) window.clearInterval(beat)
})
</script>

<template>
  <!--
    闸门三态：连接中 / 连不上 / 要令牌

    三者共用 `.gate`（居中、限宽）与 `.card`，各自的内容量差得很远 —— 连接中只有一行字，
    要令牌那一态有标题、输入框、两枚钮与两行提示。故品牌那一行放在共用的位置上：
    没有它时，「正在连接内核…」是一张浮在空白页正中的、没有出处的卡片。
  -->
  <div v-if="state === 'checking'" class="gate">
    <div class="card gate-body">
      <p class="gate-brand">
        <img class="brand-mark" :src="MARK" alt="" width="22" height="22" />
        <span class="brand">Yunzai NG</span>
      </p>
      <!-- 转圈而非只一行字：连不上时这一态会停在这里数秒，静止的文字读不出「还在试」 -->
      <p class="gate-wait"><span class="spinner" aria-hidden="true" />正在连接内核…</p>
    </div>
  </div>

  <div v-else-if="state === 'down'" class="gate">
    <div class="card gate-body">
      <p class="gate-brand">
        <img class="brand-mark" :src="MARK" alt="" width="22" height="22" />
        <span class="brand">Yunzai NG</span>
      </p>
      <h1>无法连接内核</h1>
      <p class="sub">{{ message }}</p>
      <!--
        这一态与「令牌不对」是两件事，故给出的是排查方向而不是一句「加载失败」：
        前者要去看进程还在不在，后者要去改令牌。
      -->
      <p class="hint">内核可能已停止运行，或监听地址与端口和面板不一致。请查看运行内核的终端。</p>
      <div class="gate-actions">
        <button class="primary" @click="void probe()">重试</button>
      </div>
    </div>
  </div>

  <div v-else-if="state === 'locked'" class="gate">
    <div class="card gate-body">
      <p class="gate-brand">
        <img class="brand-mark" :src="MARK" alt="" width="22" height="22" />
        <span class="brand">Yunzai NG</span>
      </p>
      <h1>需要访问令牌</h1>
      <p v-if="message !== ''" class="sub">{{ message }}</p>
      <div class="field">
        <label for="token">访问令牌</label>
        <input
          id="token"
          v-model="draftToken"
          type="password"
          autocomplete="off"
          placeholder="启动时终端输出的令牌"
          @keyup.enter="void submitToken()"
        />
        <!--
          「发送到日志」贴在输入框右下角，与提示同一行

          为「令牌抄丢了」这一种处境而设：此刻使用者被挡在面板之外，面板里的任何功能都用不上。
          它**不把令牌显示到界面上**，只请内核往日志里打一行 —— 那个端点是 `auth: false` 的
          （需要它的人恰恰没有令牌），若响应里带着令牌，浏览器里任何一个页面都能取到面板的
          全部写权限。
        -->
        <p class="hint gate-hint">
          <span>该令牌亦可在 config/yunzai.yaml 的 server.token 中查看或修改。</span>
          <button class="link" type="button" :disabled="revealing" @click="void revealToken()">
            {{ revealing ? "正在发送…" : "发送到日志" }}
          </button>
        </p>
        <p v-if="revealNote !== ''" class="hint gate-said">{{ revealNote }}</p>
      </div>
      <div class="gate-actions">
        <button class="primary" @click="void submitToken()">进入</button>
      </div>
    </div>
  </div>

  <div v-else class="shell" :class="{ open: drawer, collapsed }">
    <!--
      顶栏只为窄屏而存在：宽屏下品牌、版本与清除令牌都在侧栏里，顶栏会是一条空白横条，
      故在 860 以上整条隐去（见 styles.css 的 `.topbar` 媒体查询）。
    -->
    <header class="topbar">
      <button class="icon" aria-label="导航" :aria-expanded="drawer" @click="drawer = !drawer">☰</button>
      <span class="brand">
        Yunzai NG
        <small>{{ version }}</small>
      </span>
    </header>

    <aside class="side">
      <!-- 一：品牌区 -->
      <div class="side-brand">
        <img class="brand-mark" :src="MARK" alt="" width="22" height="22" />
        <span class="brand">
          Yunzai NG
          <small>{{ version }}</small>
        </span>
        <button
          class="icon collapse"
          :aria-label="collapsed ? '展开侧栏' : '折叠侧栏'"
          :aria-expanded="!collapsed"
          @click="toggleCollapse"
        >
          {{ collapsed ? "»" : "«" }}
        </button>
      </div>

      <!-- 二：分组导航 -->
      <nav class="nav">
        <!-- 使用锚点而非点击事件：哈希变化由 router.ts 的 hashchange 监听接管，
             中键新开标签页与右键复制链接因此均可正常工作 -->
        <template v-for="group in groups" :key="group.title">
          <p class="nav-group">{{ group.title }}</p>
          <template v-for="route in group.routes" :key="route.id">
            <!--
              展开钮与导航项**并列**，不嵌在 `<a>` 内：`<button>` 放进 `<a>` 是非法 HTML，
              浏览器会把它移出锚点重排 DOM，Vue 之后的更新便对不上自己的节点。两者由
              `.nav-row` 并成一行；不带钮的行同样过一层 `.nav-row`，免得两类行的间距不一致。
            -->
            <div class="nav-row">
              <!--
                有挂载页时「扩展页面」整行是一枚展开钮，不是链接：它自己没有内容可看，
                点它只能是「展开看下面有哪些页」。此前那个只有 28px 的箭头是个过窄的靶子，
                而点在文字上却跳到某个插件的页面 —— 使用者并没有选那一页。

                没有挂载页时仍是链接，进去看到的是「怎么注册一个页面」的说明。
              -->
              <button
                v-if="route.id === 'custom' && mountedPages.length > 0"
                class="nav-toggle"
                type="button"
                :aria-expanded="customExpanded"
                :title="customExpanded ? '收起' : '展开'"
                @click="customExpanded = !customExpanded"
              >
                <AppIcon class="nav-icon" :path="route.icon" />
                <span class="nav-label">{{ route.label }}</span>
                <AppIcon class="nav-caret" :path="customExpanded ? CARET_UP : CARET_DOWN" />
              </button>
              <a
                v-else
                :href="hrefOf(route.id)"
                :class="{ on: route.id === currentRoute }"
                :aria-current="route.id === currentRoute ? 'page' : undefined"
                :aria-label="route.label"
                :title="route.label"
              >
                <AppIcon class="nav-icon" :path="route.icon" />
                <span class="nav-label">{{ route.label }}</span>
              </a>
            </div>
            <template v-if="route.id === 'custom' && customExpanded">
              <!--
                二级项同样过一层 `.nav-row`：两类行不在同一层容器里时，行高与外边距的
                折叠方式都不一样，于是「消息统计」那一行会比它上面几行矮一两像素 ——
                样式表里早写着这条，模板此前漏了。
              -->
              <div v-for="page in mountedPages" :key="page.id" class="nav-row">
                <a
                  class="nav-child"
                  :href="hrefOf('custom', { name: page.id })"
                  :class="{ on: route.id === currentRoute && currentQuery.name === page.id }"
                  :aria-current="route.id === currentRoute && currentQuery.name === page.id ? 'page' : undefined"
                  :title="`${page.title} —— 由 ${page.provider} 提供`"
                >
                  <CustomPageIcon v-if="page.icon" class="nav-icon" :icon="page.icon" />
                  <AppIcon v-else class="nav-icon" :path="PAGE_DOT" />
                  <span class="nav-label">{{ page.title }}</span>
                </a>
              </div>
            </template>
          </template>
        </template>
      </nav>

      <!--
        三：底部区

        两枚徽标一律取两字文案（在线 / 离线 / 只读）：折叠后侧栏只有 72px，三字以上会被压到换行。
      -->
      <div class="side-foot">
        <span class="tag" :class="online ? 'ok' : 'err'">{{ online ? "在线" : "离线" }}</span>
        <span v-if="readonly" class="tag warn">只读</span>
        <!--
          主题一项与清除令牌同形：两者都是「面板本身的设置」，不是导航

          文案取当前态（跟随系统 / 浅色 / 深色）而非动作名（「切换主题」）：一个开关
          该先说清此刻是哪一态，下一步做什么由 `title` 交代。
        -->
        <button
          class="out"
          :aria-label="`主题：${THEME_LABEL[themeChoice]}，点击切换`"
          :title="`主题：${THEME_LABEL[themeChoice]}（点击切换）`"
          @click="cycleTheme"
        >
          <AppIcon class="nav-icon" :path="THEME_ICON[themeChoice]" />
          <span class="nav-label">{{ THEME_LABEL[themeChoice] }}</span>
        </button>
        <button class="out" aria-label="清除令牌" title="清除令牌" @click="signOut">
          <AppIcon class="nav-icon" :path="SIGN_OUT" />
          <span class="nav-label">清除令牌</span>
        </button>
      </div>
    </aside>

    <div class="scrim" @click="drawer = false" />

    <!--
      `page-<标识>` 是给使用者留的调样式入口，不供本仓的样式表使用

      全站的盒子共用 `.card` / `.grid` / `.row` 这些类（无 scoped 样式），改一处必然全站生效。
      这一行让每页多一个祖先选择器，于是「只改这一页的间距」有了落点，且**无须动任何视图文件**：
      各页的间距全部读 `--s1..--s8` 与 `--gutter`，在这个类下重声明令牌即可，见 styles.css 末尾
      「按页覆盖」一节。本仓自己的规则一律不写 `.page-*`，否则又回到「改一页牵连另一页」。
    -->
    <main class="main" :class="`page-${currentRoute}`">
      <!-- `mode="out-in"` 而非默认的同时进出：两个视图重叠期间页面高度会先叠加再收回，
           在长页面之间切换时表现为内容跳一下 -->
      <Transition name="page" mode="out-in">
        <component :is="view" :key="currentRoute" />
      </Transition>
    </main>
  </div>

  <!--
    确认对话框：全站只此一个实例

    与闸门、外壳平级，故无论哪一态都在场；自身按 `confirm.ts` 的 `pending` 决定是否渲染，
    平时不产生任何节点。原生 `<dialog>` 在 top layer，不参与 `z-index` 竞争。
  -->
  <ConfirmDialog />

  <!--
    目录选择器：同样全站一个实例，同样在闸门与外壳之外

    与确认对话框互不感知，也不可能同时打开两个 —— 它的入口在配置表单里，而确认对话框打开时
    焦点被原生 `<dialog>` 锁住，表单不可操作。
  -->
  <PathPicker />
</template>
