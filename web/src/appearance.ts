/**
 * 模块职责：外观偏好 —— 当前主题、个人偏好与「各主题允许改的项」，持久化并落到 CSS 变量与 `<html>` 属性
 * 依赖方向：依赖 vue 的 ref / watch 与 localStorage；不 import themes.ts（反过来由它写 `activeTheme`）
 * 生命周期：模块级单例；`initAppearance()` 在 `main.ts` 里调一次
 * 注意事项：**三层，各管各的。**
 *          - 主题（`theme`）：选哪一身皮肤，内容由主题包给，见 themes.ts。
 *          - 个人偏好（`prefs`）：密度、字号、内容宽度、动效、低功耗 —— 跟着人走，换哪款主题都保留。
 *          - 主题内的改动（`perTheme[id]`）：强调色、圆角、背景 —— 按主题分别存。给 YUNZAI NG 调的色相
 *            不该带进下一款主题；而一款主题不允许改的项（清单里 `options` 没开）此处不写，主题说了算。
 *
 *          **没改过的项不写 CSS 变量。** 写了就是行内样式，盖过主题在 `@layer theme` 里的取值 ——
 *          主题自己的圆角、强调色便永远出不来。故只写使用者明确改过、且当前主题允许改的那几项，
 *          其余由主题（没写时由经典）决定。
 *
 *          明暗不在此处，见 scheme.ts。
 */
import { ref, watch } from "vue"

/** 外观配置在 localStorage 中的键 */
export const APPEARANCE_KEY = "yunzai-ng.appearance"

/** 新装默认的主题 */
export const DEFAULT_THEME = "classic"

/** 个人偏好：与主题无关 */
export interface AppearancePrefs {
  /** 间距密度 */
  density: "compact" | "normal" | "comfortable"
  /** 字号档位 */
  fontScale: "small" | "normal" | "large"
  /** 内容区最大宽度 */
  width: "narrow" | "normal" | "wide" | "full"
  /** 动效：完整、减弱、关闭 */
  motion: "full" | "reduced" | "off"
  /** 低功耗：关掉背景动画、光斑与大图，手机上推荐 */
  lowPower: boolean
}

/** 一款主题之内可改的项；没写的就是「用主题自己的」 */
export interface ThemeOverrides {
  /** 强调色色相（0-360） */
  accentHue?: number
  /** 圆角大小 */
  radius?: "small" | "medium" | "large"
  /** 页面背景：渐变、点阵、纯色、主题背景图 */
  backdrop?: "gradient" | "dots" | "plain" | "image"
}

/** 落盘的全部外观配置 */
export interface AppearanceState {
  /** 当前主题 id */
  theme: string
  /** 个人偏好 */
  prefs: AppearancePrefs
  /** 各主题之内的改动，键是主题 id */
  perTheme: Record<string, ThemeOverrides>
}

/** 当前主题允许改哪些项、自己的缺省是什么；由 themes.ts 在换主题时写入 */
export interface ActiveThemeInfo {
  /** 主题 id */
  id: string
  /** 允许改的项 */
  options: { accentHue: boolean; radius: boolean; backdrop: boolean }
  /** 主题自己的缺省背景 */
  defaultBackdrop: NonNullable<ThemeOverrides["backdrop"]>
}

/** 圆角档位对应的取值 */
export const RADIUS_MAP: Record<NonNullable<ThemeOverrides["radius"]>, { card: string; ctl: string }> = {
  small: { card: "8px", ctl: "6px" },
  medium: { card: "14px", ctl: "10px" },
  large: { card: "20px", ctl: "14px" }
}

/** 密度档位对应的间距倍率 */
const DENSITY_MAP: Record<AppearancePrefs["density"], number> = {
  compact: 0.85,
  normal: 1,
  comfortable: 1.2
}

/** 字号档位对应的倍率 */
const FONT_MAP: Record<AppearancePrefs["fontScale"], number> = {
  small: 0.93,
  normal: 1,
  large: 1.08
}

/** 宽度档位对应的 `--content-max` */
const WIDTH_MAP: Record<AppearancePrefs["width"], string> = {
  narrow: "1040px",
  normal: "1240px",
  wide: "1480px",
  full: "none"
}

/** 动效档位对应的四档时长（毫秒） */
const MOTION_MAP: Record<AppearancePrefs["motion"], readonly [number, number, number, number]> = {
  full: [150, 250, 350, 500],
  reduced: [90, 140, 180, 240],
  off: [1, 1, 1, 1]
}

/** 默认字号，与 styles.css 的 `:root` 一致 */
const FONT_BASE = { h1: 22, h2: 16, h3: 13.5, body: 14, hint: 12.5, label: 11.5 } as const

/** 默认个人偏好 */
export const DEFAULT_PREFS: AppearancePrefs = {
  density: "normal",
  fontScale: "normal",
  width: "normal",
  motion: "full",
  lowPower: false
}

/** 经典主题的信息：清单还没取回来时就按它算 */
export const CLASSIC_INFO: ActiveThemeInfo = {
  id: DEFAULT_THEME,
  options: { accentHue: true, radius: true, backdrop: true },
  defaultBackdrop: "gradient"
}

/** 默认色相，与经典主题的 --accent-hue 一致 */
export const DEFAULT_ACCENT_HUE = 232

/** 配色预设：只是几个常用的色相，点了即写进当前主题的 `accentHue` */
export const COLOR_PRESETS: readonly { id: string; name: string; hue: number }[] = [
  { id: "cloud", name: "云蓝", hue: DEFAULT_ACCENT_HUE },
  { id: "indigo", name: "靛紫", hue: 239 },
  { id: "ocean", name: "海湾", hue: 199 },
  { id: "forest", name: "松林", hue: 152 },
  { id: "amber", name: "琥珀", hue: 40 },
  { id: "sunset", name: "暮色", hue: 18 },
  { id: "rose", name: "玫瑰", hue: 340 },
  { id: "amethyst", name: "紫晶", hue: 280 }
]

/** 各偏好项的合法取值，用于校验落盘数据 */
const PREF_ALLOWED: { [K in keyof AppearancePrefs]?: readonly AppearancePrefs[K][] } = {
  density: ["compact", "normal", "comfortable"],
  fontScale: ["small", "normal", "large"],
  width: ["narrow", "normal", "wide", "full"],
  motion: ["full", "reduced", "off"]
}

/** 主题 id 的合法字符，与服务端 themescan.ts 的 `isSafeThemeId` 一致 */
const THEME_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * 是不是一个普通对象
 * @param value 任意值
 * @returns 是否为对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 只保留合法的偏好项
 * @param raw 任意值
 * @returns 合法的偏好项
 */
export function sanitizePrefs(raw: unknown): Partial<AppearancePrefs> {
  if (!isRecord(raw)) return {}
  const out: Partial<Record<keyof AppearancePrefs, unknown>> = {}
  for (const [key, allowed] of Object.entries(PREF_ALLOWED) as [keyof AppearancePrefs, readonly unknown[]][]) {
    if (allowed.includes(raw[key])) out[key] = raw[key]
  }
  if (typeof raw.lowPower === "boolean") out.lowPower = raw.lowPower
  return out as Partial<AppearancePrefs>
}

/**
 * 只保留合法的主题内改动
 * @param raw 任意值
 * @returns 合法的改动
 */
export function sanitizeOverrides(raw: unknown): ThemeOverrides {
  if (!isRecord(raw)) return {}
  const out: ThemeOverrides = {}
  const hue = raw.accentHue
  if (typeof hue === "number" && Number.isFinite(hue)) out.accentHue = Math.min(360, Math.max(0, Math.round(hue)))
  if (raw.radius === "small" || raw.radius === "medium" || raw.radius === "large") out.radius = raw.radius
  if (raw.backdrop === "gradient" || raw.backdrop === "dots" || raw.backdrop === "plain" || raw.backdrop === "image") {
    out.backdrop = raw.backdrop
  }
  return out
}

/**
 * 默认的整份配置
 * @returns 新对象
 */
export function defaultState(): AppearanceState {
  return { theme: DEFAULT_THEME, prefs: { ...DEFAULT_PREFS }, perTheme: {} }
}

/**
 * 把旧版（`{ values: {...} }` 或更早的 `{ preset, custom }`）迁成新格式
 *
 * 旧版没有「主题」的概念，那时的外观就是今天的经典主题，故色相、圆角、背景一律归到经典名下；
 * 玻璃拟态已去掉，那一项丢弃。旧版的视觉方案「紧凑 / 舒适」只剩密度、字号、宽度三项还有意义。
 * @param obj 旧版对象
 * @returns 新格式
 */
function migrateV1(obj: Record<string, unknown>): AppearanceState {
  const legacy: Record<string, unknown> =
    obj.preset === "compact"
      ? { radius: "small", density: "compact", fontScale: "small", width: "wide" }
      : obj.preset === "comfortable"
        ? { radius: "large", density: "comfortable", fontScale: "large" }
        : {}
  const values = { ...legacy, ...(isRecord(obj.values) ? obj.values : {}), ...(isRecord(obj.custom) ? obj.custom : {}) }
  const overrides = sanitizeOverrides(values)
  // 旧默认（239 / 中圆角 / 渐变）就是经典自己的样子，不当作「改过」记下来
  if (overrides.accentHue === 239) delete overrides.accentHue
  if (overrides.radius === "medium") delete overrides.radius
  if (overrides.backdrop === "gradient") delete overrides.backdrop
  return {
    theme: DEFAULT_THEME,
    prefs: { ...DEFAULT_PREFS, ...sanitizePrefs(values) },
    perTheme: Object.keys(overrides).length > 0 ? { [DEFAULT_THEME]: overrides } : {}
  }
}

/**
 * 解析一份外观配置，新旧格式都认
 * @param parsed JSON 解析结果
 * @returns 完整配置，缺项取默认
 */
export function parseAppearance(parsed: unknown): AppearanceState {
  if (!isRecord(parsed)) return defaultState()
  if (parsed.version !== 2) return migrateV1(parsed)
  const theme = typeof parsed.theme === "string" && THEME_ID.test(parsed.theme) ? parsed.theme : DEFAULT_THEME
  const perTheme: Record<string, ThemeOverrides> = {}
  if (isRecord(parsed.perTheme)) {
    for (const [id, raw] of Object.entries(parsed.perTheme)) {
      const clean = sanitizeOverrides(raw)
      if (THEME_ID.test(id) && Object.keys(clean).length > 0) perTheme[id] = clean
    }
  }
  return { theme, prefs: { ...DEFAULT_PREFS, ...sanitizePrefs(parsed.prefs) }, perTheme }
}

/**
 * 解析落盘的外观配置
 * @param raw 原始字符串
 * @returns 完整配置；格式错误时退回默认
 */
export function readAppearance(raw: string | null): AppearanceState {
  if (raw === null || raw === "") return defaultState()
  try {
    return parseAppearance(JSON.parse(raw))
  } catch {
    return defaultState()
  }
}

/**
 * 当前主题之内实际生效的改动：只留主题允许改的那几项
 * @param state 外观配置
 * @param info 当前主题的信息
 * @returns 生效的改动
 */
export function effectiveOverrides(state: AppearanceState, info: ActiveThemeInfo): ThemeOverrides {
  const own = state.perTheme[info.id] ?? {}
  const out: ThemeOverrides = {}
  if (info.options.accentHue && own.accentHue !== undefined) out.accentHue = own.accentHue
  if (info.options.radius && own.radius !== undefined) out.radius = own.radius
  if (info.options.backdrop && own.backdrop !== undefined) out.backdrop = own.backdrop
  return out
}

/**
 * 由配置算出要写成行内样式的 CSS 变量
 *
 * 个人偏好那几项每次都写（它们与主题无关，经典的取值就是基准）；主题内的改动只写改过的，
 * 理由见文件头。
 * @param state 外观配置
 * @param info 当前主题的信息
 * @returns 变量名到取值
 */
export function cssVariablesOf(state: AppearanceState, info: ActiveThemeInfo): Record<string, string> {
  const { prefs } = state
  const density = DENSITY_MAP[prefs.density]
  const font = FONT_MAP[prefs.fontScale]
  const vars: Record<string, string> = {
    "--density-factor": String(density),
    "--content-max": WIDTH_MAP[prefs.width]
  }
  for (let i = 1; i <= 6; i++) vars[`--s${i}`] = `${Math.round(4 * i * density)}px`
  for (const [name, size] of Object.entries(FONT_BASE)) vars[`--fs-${name}`] = `${Math.round(size * font * 2) / 2}px`
  MOTION_MAP[prefs.motion].forEach((ms, i) => (vars[`--dur-${i + 1}`] = `${ms}ms`))

  const own = effectiveOverrides(state, info)
  if (own.accentHue !== undefined) vars["--accent-hue"] = String(own.accentHue)
  if (own.radius !== undefined) {
    vars["--r-card"] = RADIUS_MAP[own.radius].card
    vars["--r-ctl"] = RADIUS_MAP[own.radius].ctl
  }
  return vars
}

/**
 * 实际生效的背景：改过的优先，否则主题自己的
 * @param state 外观配置
 * @param info 当前主题的信息
 * @returns 背景档位
 */
export function backdropOf(state: AppearanceState, info: ActiveThemeInfo): NonNullable<ThemeOverrides["backdrop"]> {
  return effectiveOverrides(state, info).backdrop ?? info.defaultBackdrop
}

/** 当前外观配置 */
export const appearance = ref<AppearanceState>(defaultState())

/** 当前主题的信息；themes.ts 换主题时写入，appearance 据它决定写哪些变量 */
export const activeTheme = ref<ActiveThemeInfo>(CLASSIC_INFO)

/** 上一次写到 `<html>` 上的变量名，换主题时据它把不再该写的那几项摘掉 */
let written = new Set<string>()

/**
 * 写到 `<html>` 上
 * @param state 外观配置
 * @param info 当前主题的信息
 */
function apply(state: AppearanceState, info: ActiveThemeInfo): void {
  const root = document.documentElement
  const vars = cssVariablesOf(state, info)
  for (const key of written) if (!(key in vars)) root.style.removeProperty(key)
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)
  written = new Set(Object.keys(vars))
  root.dataset.motion = state.prefs.motion
  root.dataset.backdrop = backdropOf(state, info)
  root.dataset.lowPower = state.prefs.lowPower ? "on" : "off"
}

/**
 * 改一项个人偏好
 * @param key 偏好项
 * @param value 取值
 */
export function updatePref<K extends keyof AppearancePrefs>(key: K, value: AppearancePrefs[K]): void {
  appearance.value = { ...appearance.value, prefs: { ...appearance.value.prefs, [key]: value } }
}

/**
 * 改当前主题之内的一项；给 undefined 即「恢复主题自己的」
 * @param key 改动项
 * @param value 取值
 */
export function updateOverride<K extends keyof ThemeOverrides>(key: K, value: ThemeOverrides[K]): void {
  const id = appearance.value.theme
  const next: ThemeOverrides = { ...(appearance.value.perTheme[id] ?? {}) }
  if (value === undefined) delete next[key]
  else next[key] = value
  const perTheme = { ...appearance.value.perTheme }
  if (Object.keys(next).length > 0) perTheme[id] = next
  else delete perTheme[id]
  appearance.value = { ...appearance.value, perTheme }
}

/**
 * 记下所选主题；真正的加载由 themes.ts 监听这个值去做
 * @param id 主题 id
 */
export function chooseTheme(id: string): void {
  if (THEME_ID.test(id)) appearance.value = { ...appearance.value, theme: id }
}

/** 把当前主题之内的改动全部撤掉 */
export function resetOverrides(): void {
  const perTheme = { ...appearance.value.perTheme }
  delete perTheme[appearance.value.theme]
  appearance.value = { ...appearance.value, perTheme }
}

/** 个人偏好恢复默认 */
export function resetPrefs(): void {
  appearance.value = { ...appearance.value, prefs: { ...DEFAULT_PREFS } }
}

/** 全部恢复默认，主题也回到经典 */
export function resetAppearance(): void {
  appearance.value = defaultState()
}

/**
 * 当前配置的 JSON 文本，供导出
 * @returns JSON
 */
export function exportAppearance(): string {
  return JSON.stringify({ version: 2, ...appearance.value }, null, 2)
}

/**
 * 导入一份配置，新旧格式都认
 * @param raw JSON 文本
 * @returns 是否成功；不是 JSON 对象时不作改动
 */
export function importAppearance(raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false
  appearance.value = parseAppearance(parsed)
  return true
}

/**
 * 当前是否播放动画；关闭动效或系统要求减少动效时为假
 * @returns 是否播放
 */
export function motionEnabled(): boolean {
  if (appearance.value.prefs.motion === "off") return false
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * 落盘当前配置；浏览器禁止本地存储时只在本次会话内生效
 * @param state 外观配置
 */
function save(state: AppearanceState): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ version: 2, ...state }))
  } catch {
    // 同上
  }
}

/** 读落盘配置并立即生效，此后每次变化自动应用与保存 */
export function initAppearance(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(APPEARANCE_KEY)
  } catch {
    // 读不到即用默认
  }
  appearance.value = readAppearance(raw)

  watch(
    [appearance, activeTheme],
    ([state, info]) => {
      apply(state, info)
      save(state)
    },
    { immediate: true, deep: true }
  )
}
