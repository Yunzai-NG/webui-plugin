/**
 * 模块职责：主题运行时 —— 取主题表、套用所选的那一款（样式表、槽位、图标、脚本）、写首帧缓存
 * 依赖方向：依赖 api（取主题表）、appearance（所选的 id，与写回 `activeTheme`）、scheme（明暗）、themeview（纯函数）
 * 生命周期：模块级单例；`initThemes()` 在 `main.ts` 里调一次，`reloadThemes()` 在过了令牌闸门之后再调
 * 注意事项：**主题坏了一律退回经典，不让面板打不开。** 样式表取不到、脚本抛错、清单里的 id 已被卸掉 ——
 *          都只在控制台说一句，外观页上标出来。
 *
 *          **安全模式**：地址里带 `?theme=safe` 时不加载任何主题、不跑任何主题脚本。一款写坏的主题
 *          把外观页本身遮住时，使用者得有一条路回去。
 *
 *          **首帧**由 index.html 的内联脚本按 `FIRST_PAINT_KEY` 里的缓存先插上样式表与变量，
 *          本模块取到主题表后核对一遍，对不上就换。没有这层缓存，换过主题的人每次打开都会
 *          先看到一帧经典。
 *
 *          **主题脚本**是一个 ES 模块，默认导出 `setup(ctx)`，可返回一个收尾函数。换主题或安全模式时
 *          收尾函数一定被调用 —— 主题挂的计时器、监听器、往页面里加的节点都要在那里撤掉。
 *          脚本与面板插件同等信任（面板商店装来的代码本就跑在面板里），故不另设沙箱。
 */
import { computed, ref, watch } from "vue"
import { getAt } from "./api.js"
import { activeTheme, appearance, motionEnabled, type ActiveThemeInfo } from "./appearance.js"
import { schemeMode, supportedSchemes, type SchemeMode } from "./scheme.js"
import { CLASSIC, FIRST_PAINT_KEY, firstPaintOf, pickTheme, slotVarsOf, type ThemeInfo } from "./themeview.js"

export type { ThemeInfo } from "./themeview.js"

/** 主题表端点 */
const THEMES_URL = "/plugin/webui/themes.json"

/** 主题样式表那个 `<link>` 的 id，与 index.html 的内联脚本一致 */
const LINK_ID = "yz-theme-css"

/** 是否处于安全模式 */
export const safeMode = typeof location !== "undefined" && new URLSearchParams(location.search).get("theme") === "safe"

/** 已装的主题 */
export const themeList = ref<ThemeInfo[]>([CLASSIC])

/** 站点默认主题 id，来自 webui 配置 */
export const siteDefault = ref(CLASSIC.id)

/** 当前生效的主题 */
export const currentTheme = ref<ThemeInfo>(CLASSIC)

/** 最近一次加载失败的原因；外观页把它摆出来 */
export const themeError = ref("")

/** 主题表是否已取回来过 */
export const themesLoaded = ref(false)

/**
 * 每次主题真正落定（样式表加载完、或换成没有样式表的经典）加一
 *
 * 给扩展页发主题的那一侧据它重发：要等新样式表生效之后再读令牌的计算值，读早了拿到的是旧主题的。
 */
export const themeRevision = ref(0)

/** 当前主题某个槽位的图；没有时 undefined。面板组件与 `api.theme.asset()` 都读它 */
export const slotOf = (name: string): string | undefined => {
  const value = currentTheme.value.slots[name]
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  if ("image" in value) return value.image
  return schemeMode.value === "dark" ? (value.dark ?? value.light) : (value.light ?? value.dark)
}

/** 当前主题替换的导航图标：路由 id → 图片地址或 path 数据 */
export const navIcons = computed(() => currentTheme.value.icons)

/** 主题脚本拿到的上下文 */
export interface ThemeScriptContext {
  /** 主题 id */
  readonly id: string
  /** 当前明暗，只读 */
  readonly scheme: () => SchemeMode
  /** `<html>` */
  readonly root: HTMLElement
  /**
   * 取本主题某个槽位的图
   * @param name 槽位名
   * @returns 地址；没有时 undefined
   */
  readonly asset: (name: string) => string | undefined
  /** 低功耗是否开着：开着时别跑常驻动画 */
  readonly lowPower: () => boolean
  /** 当前是否播放动效 */
  readonly motion: () => boolean
  /**
   * 明暗变化时回调
   * @param fn 回调
   */
  readonly onSchemeChange: (fn: (scheme: SchemeMode) => void) => void
}

/** 当前主题脚本的收尾 */
let teardown: (() => void)[] = []

/** 每次换主题加一，晚到的脚本据它知道自己已经过时 */
let generation = 0

/** 停掉当前主题的脚本 */
function stopScript(): void {
  const fns = teardown
  teardown = []
  for (const fn of fns) {
    try {
      fn()
    } catch (err) {
      console.error("主题脚本的收尾函数抛错", err)
    }
  }
}

/**
 * 跑一款主题的脚本
 * @param theme 主题
 * @param gen 本次换主题的代号
 */
async function runScript(theme: ThemeInfo, gen: number): Promise<void> {
  if (theme.script === undefined || safeMode) return
  try {
    const mod = (await import(/* @vite-ignore */ theme.script)) as { default?: unknown }
    if (gen !== generation) return
    if (typeof mod.default !== "function") {
      console.error(`主题 ${theme.id} 的脚本没有默认导出 setup 函数，已跳过`)
      return
    }
    const ctx: ThemeScriptContext = {
      id: theme.id,
      scheme: () => schemeMode.value,
      root: document.documentElement,
      asset: name => slotOf(name),
      lowPower: () => appearance.value.prefs.lowPower,
      motion: motionEnabled,
      onSchemeChange: fn => {
        teardown.push(watch(schemeMode, value => fn(value)))
      }
    }
    const done = await (mod.default as (ctx: ThemeScriptContext) => unknown)(ctx)
    if (typeof done === "function") teardown.push(done as () => void)
    if (gen !== generation) stopScript()
  } catch (err) {
    themeError.value = `主题 ${theme.name} 的脚本出错，已停用：${err instanceof Error ? err.message : String(err)}`
    console.error(themeError.value, err)
    stopScript()
  }
}

/**
 * 换上样式表：换成新的 `<link>`，等它加载完再拆旧的 —— 中间不留一帧没样式
 * @param href 样式表地址；经典为 undefined
 */
function swapStyle(href: string | undefined): void {
  const old = document.getElementById(LINK_ID)
  if (href === undefined) {
    old?.remove()
    themeRevision.value += 1
    return
  }
  if (old instanceof HTMLLinkElement && old.getAttribute("href") === href) {
    themeRevision.value += 1
    return
  }
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = href
  link.addEventListener("load", () => {
    old?.remove()
    link.id = LINK_ID
    themeRevision.value += 1
  })
  link.addEventListener("error", () => {
    themeError.value = `主题样式表 ${href} 取不到，暂用经典外观`
    link.remove()
    old?.remove()
  })
  document.head.append(link)
}

/** 上一次写到 `<html>` 上的槽位变量名 */
let slotWritten = new Set<string>()

/**
 * 写槽位变量与 `data-slots`
 * @param theme 主题
 * @param scheme 当前明暗
 */
function applySlots(theme: ThemeInfo, scheme: SchemeMode): void {
  const root = document.documentElement
  const { vars, names } = slotVarsOf(theme.slots, scheme)
  for (const key of slotWritten) if (!(key in vars)) root.style.removeProperty(key)
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)
  slotWritten = new Set(Object.keys(vars))
  root.dataset.slots = names.join(" ")
}

/**
 * 写首帧缓存
 * @param theme 主题
 * @param scheme 当前明暗
 */
function saveFirstPaint(theme: ThemeInfo, scheme: SchemeMode): void {
  try {
    if (theme.id === CLASSIC.id) localStorage.removeItem(FIRST_PAINT_KEY)
    else localStorage.setItem(FIRST_PAINT_KEY, JSON.stringify(firstPaintOf(theme, scheme)))
  } catch {
    // 只影响下次打开的第一帧
  }
}

/**
 * 套用一款主题
 * @param theme 主题
 */
function apply(theme: ThemeInfo): void {
  generation += 1
  const gen = generation
  stopScript()
  themeError.value = ""
  currentTheme.value = theme
  document.documentElement.dataset.themeId = theme.id
  swapStyle(theme.style)
  applySlots(theme, schemeMode.value)
  supportedSchemes.value = theme.schemes.length > 0 ? theme.schemes : ["light", "dark"]
  const info: ActiveThemeInfo = {
    id: theme.id,
    options: theme.options,
    defaultBackdrop: theme.backdrop === "image" && slotOf("backdrop") === undefined ? "gradient" : theme.backdrop
  }
  activeTheme.value = info
  saveFirstPaint(theme, schemeMode.value)
  void runScript(theme, gen)
}

/** 是否已经正式套用过一次（首帧缓存那一款只是占位，还没跑过脚本、没写过 `activeTheme`） */
let applied = false

/** 按当前的选择与主题表决定该用哪一款，与正在用的不同就换 */
function settle(): void {
  const next = safeMode ? CLASSIC : pickTheme(themeList.value, appearance.value.theme, siteDefault.value)
  if (applied && next.id === currentTheme.value.id) return
  applied = true
  apply(next)
}

/**
 * 取一次主题表
 *
 * 没过令牌闸门时这一步会 401，那时什么都不改：首帧缓存已经套上了上次的主题，
 * 等过了闸门 App.vue 再调一次。
 */
export async function reloadThemes(): Promise<void> {
  try {
    const got = await getAt<{ themes?: ThemeInfo[]; defaultTheme?: string }>(THEMES_URL)
    const list = Array.isArray(got.themes) && got.themes.length > 0 ? got.themes : [CLASSIC]
    themeList.value = list.some(t => t.id === CLASSIC.id) ? list : [CLASSIC, ...list]
    siteDefault.value = typeof got.defaultTheme === "string" ? got.defaultTheme : CLASSIC.id
    themesLoaded.value = true
    // 重取之后主题内容可能变了（商店里刚更新过），同 id 也要重新套一次
    applied = false
    settle()
  } catch {
    // 闸门之前取不到是常态；之后取不到就维持现状
  }
}

/**
 * 首帧缓存里记着的主题，在主题表回来之前先当作当前主题
 *
 * 只取 id 与支持的明暗：样式表与槽位变量内联脚本已经写好了，这里不重写，免得闪一下。
 */
function adoptFirstPaint(): void {
  if (safeMode) {
    document.getElementById(LINK_ID)?.remove()
    document.documentElement.dataset.themeId = CLASSIC.id
    return
  }
  try {
    const raw = localStorage.getItem(FIRST_PAINT_KEY)
    if (raw === null) return
    const cached = JSON.parse(raw) as { id?: unknown; schemes?: unknown }
    if (typeof cached.id !== "string") return
    const schemes = Array.isArray(cached.schemes)
      ? cached.schemes.filter((s): s is SchemeMode => s === "light" || s === "dark")
      : []
    currentTheme.value = { ...CLASSIC, id: cached.id, name: cached.id, builtin: false, schemes }
    supportedSchemes.value = schemes.length > 0 ? schemes : ["light", "dark"]
  } catch {
    // 缓存坏了就当没有
  }
}

/** 接上：先认首帧缓存，再取主题表；此后所选的主题或明暗一变就重新套用 */
export function initThemes(): void {
  adoptFirstPaint()
  watch(
    () => appearance.value.theme,
    () => settle()
  )
  watch(schemeMode, scheme => {
    applySlots(currentTheme.value, scheme)
    saveFirstPaint(currentTheme.value, scheme)
  })
  void reloadThemes()
}
