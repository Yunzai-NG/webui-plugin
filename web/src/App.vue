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
import { get, getAt, getToken, setToken } from "./api.js"
import { ApiError } from "./api.js"
import { errorText } from "./format.js"
import { ROUTES, currentQuery, currentRoute, hrefOf, type RouteDef } from "./router.js"
import { THEME_LABEL, cycleTheme, themeChoice, type ThemeChoice } from "./theme.js"
import type { Overview } from "./types.js"
import AppIcon from "./components/AppIcon.vue"
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

interface MountedPage { id: string; title: string; icon?: string; plugin: string }

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
  appearance: AppearanceView
  ,custom: CustomPageView
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

/** 清除令牌并返回闸门 */
function signOut(): void {
  setToken("")
  draftToken.value = ""
  state.value = "locked"
  message.value = "已清除本机保存的令牌"
}

watch(currentRoute, () => {
  drawer.value = false
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
  <div v-if="state === 'checking'" class="gate card">正在连接内核…</div>

  <div v-else-if="state === 'down'" class="gate card">
    <h1>无法连接内核</h1>
    <p class="sub">{{ message }}</p>
    <button class="primary" @click="void probe()">重试</button>
  </div>

  <div v-else-if="state === 'locked'" class="gate card">
    <h1>需要访问令牌</h1>
    <p class="sub">{{ message }}</p>
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
      <p class="hint">该令牌亦可在 config/yunzai.yaml 的 server.token 中查看或修改。</p>
    </div>
    <button class="primary" @click="void submitToken()">进入</button>
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
            <a
              :href="hrefOf(route.id)"
              :class="{ on: route.id === currentRoute }"
              :aria-current="route.id === currentRoute ? 'page' : undefined"
              :aria-label="route.label"
              :title="route.label"
            >
              <AppIcon class="nav-icon" :path="route.icon" />
              <span class="nav-label">{{ route.label }}</span>
              <button
                v-if="route.id === 'custom'"
                class="nav-expand"
                type="button"
                @click.prevent.stop="customExpanded = !customExpanded"
              >{{ customExpanded ? "⌃" : "⌄" }}</button>
            </a>
            <template v-if="route.id === 'custom' && customExpanded">
              <a
                v-for="page in mountedPages"
                :key="`${page.plugin}:${page.id}`"
                class="nav-child"
                :href="hrefOf('custom', { name: page.id })"
                :class="{ on: route.id === currentRoute && currentQuery.name === page.id }"
              >
                <span class="nav-child-icon">{{ page.icon || "🦊" }}</span><span class="nav-label">{{ page.title }}</span>
              </a>
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

    <main class="main">
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
