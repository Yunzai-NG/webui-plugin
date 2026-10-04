/**
 * 模块职责：外观配置 —— 视觉方案、配色方案、逐项细调、持久化，以及落到 CSS 变量与 `<html>` 属性上
 * 依赖方向：依赖 vue 的 ref / watch 与 localStorage
 * 生命周期：模块级单例；`initAppearance()` 在 `main.ts` 里调一次
 * 注意事项：数值类参数写成 CSS 变量，开关类参数写成 `<html data-*>`，样式表按属性取用，修改即时生效。
 *
 *          视觉方案只管形（圆角、密度、字号、宽度、背景、玻璃），配色方案只管色（强调色），互不覆盖；
 *          动效是个人偏好，不归任何方案。落盘只存最终取值，当前属于哪个方案由取值反推，对不上即「自定义」。
 *          深浅主题不在此处，见 theme.ts。
 */
import { ref, watch } from "vue"

/** 外观配置在 localStorage 中的键 */
export const APPEARANCE_KEY = "yunzai-ng.appearance"

/** 取值对不上任何方案时的标识 */
export const CUSTOM = "custom"

/** 可自定义的外观参数 */
export interface AppearanceValues {
  /** 圆角大小 */
  radius: "small" | "medium" | "large"
  /** 间距密度 */
  density: "compact" | "normal" | "comfortable"
  /** 强调色色相（0-360） */
  accentHue: number
  /** 是否启用玻璃拟态 */
  glassEffect: boolean
  /** 字号档位 */
  fontScale: "small" | "normal" | "large"
  /** 内容区最大宽度 */
  width: "narrow" | "normal" | "wide" | "full"
  /** 动效：完整、减弱、关闭 */
  motion: "full" | "reduced" | "off"
  /** 页面背景：渐变、点阵、纯色 */
  backdrop: "gradient" | "dots" | "plain"
}

/** 视觉方案管辖的参数 */
export const LAYOUT_KEYS = ["radius", "density", "fontScale", "width", "backdrop", "glassEffect"] as const

/** 视觉方案管辖的参数名 */
export type LayoutKey = (typeof LAYOUT_KEYS)[number]

/** 视觉方案标识 */
export type LayoutPresetId = "default" | "compact" | "comfortable"

/** 配色方案标识 */
export type ColorPresetId = "indigo" | "ocean" | "forest" | "amber" | "sunset" | "rose" | "amethyst"

/** 视觉方案 */
export interface LayoutPreset {
  /** 方案标识 */
  id: LayoutPresetId
  /** 显示名 */
  name: string
  /** 一句话说明 */
  description: string
  /** 套用时写入的参数 */
  values: Pick<AppearanceValues, LayoutKey>
}

/** 配色方案 */
export interface ColorPreset {
  /** 方案标识 */
  id: ColorPresetId
  /** 显示名 */
  name: string
  /** 主色色相，0–360 */
  hue: number
}

/** 圆角档位对应的取值 */
const RADIUS_MAP: Record<AppearanceValues["radius"], { card: string; ctl: string }> = {
  small: { card: "8px", ctl: "6px" },
  medium: { card: "14px", ctl: "10px" },
  large: { card: "20px", ctl: "14px" }
}

/** 密度档位对应的间距倍率 */
const DENSITY_MAP: Record<AppearanceValues["density"], number> = {
  compact: 0.85,
  normal: 1,
  comfortable: 1.2
}

/** 字号档位对应的倍率 */
const FONT_MAP: Record<AppearanceValues["fontScale"], number> = {
  small: 0.93,
  normal: 1,
  large: 1.08
}

/** 宽度档位对应的 `--content-max` */
const WIDTH_MAP: Record<AppearanceValues["width"], string> = {
  narrow: "1040px",
  normal: "1240px",
  wide: "1480px",
  full: "none"
}

/** 动效档位对应的四档时长（毫秒） */
const MOTION_MAP: Record<AppearanceValues["motion"], readonly [number, number, number, number]> = {
  full: [150, 250, 350, 500],
  reduced: [90, 140, 180, 240],
  off: [1, 1, 1, 1]
}

/** 默认字号，与 styles.css 的 `:root` 一致 */
const FONT_BASE = { h1: 22, h2: 16, h3: 13.5, body: 14, hint: 12.5, label: 11.5 } as const

/** 默认外观参数 */
export const DEFAULT_VALUES: AppearanceValues = {
  radius: "medium",
  density: "normal",
  accentHue: 239,
  glassEffect: false,
  fontScale: "normal",
  width: "normal",
  motion: "full",
  backdrop: "gradient"
}

/**
 * 以默认值为底拼一份视觉方案
 * @param id 标识
 * @param name 显示名
 * @param description 描述
 * @param values 与默认值不同的项
 * @returns 视觉方案
 */
function layout(
  id: LayoutPresetId,
  name: string,
  description: string,
  values: Partial<LayoutPreset["values"]>
): LayoutPreset {
  const base = Object.fromEntries(LAYOUT_KEYS.map(k => [k, DEFAULT_VALUES[k]])) as LayoutPreset["values"]
  return { id, name, description, values: { ...base, ...values } }
}

/** 视觉方案 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  layout("default", "默认", "平衡的圆角、间距与字号，适合大多数场景", {}),
  layout("compact", "紧凑", "更小的圆角、间距与字号，内容区更宽", {
    radius: "small",
    density: "compact",
    fontScale: "small",
    width: "wide"
  }),
  layout("comfortable", "舒适", "更大的圆角、间距与字号，卡片半透明", {
    radius: "large",
    density: "comfortable",
    fontScale: "large",
    glassEffect: true
  })
]

/** 配色方案 */
export const COLOR_PRESETS: readonly ColorPreset[] = [
  { id: "indigo", name: "靛紫", hue: 239 },
  { id: "ocean", name: "海湾", hue: 199 },
  { id: "forest", name: "松林", hue: 152 },
  { id: "amber", name: "琥珀", hue: 40 },
  { id: "sunset", name: "暮色", hue: 18 },
  { id: "rose", name: "玫瑰", hue: 340 },
  { id: "amethyst", name: "紫晶", hue: 280 }
]

/** 各参数的合法取值，用于校验落盘数据 */
const ALLOWED: { [K in keyof AppearanceValues]?: readonly AppearanceValues[K][] } = {
  radius: ["small", "medium", "large"],
  density: ["compact", "normal", "comfortable"],
  fontScale: ["small", "normal", "large"],
  width: ["narrow", "normal", "wide", "full"],
  motion: ["full", "reduced", "off"],
  backdrop: ["gradient", "dots", "plain"]
}

/**
 * 只保留合法的参数
 * @param raw 任意值
 * @returns 合法的参数
 */
export function sanitizeValues(raw: unknown): Partial<AppearanceValues> {
  if (typeof raw !== "object" || raw === null) return {}
  const src = raw as Record<string, unknown>
  const out: Partial<Record<keyof AppearanceValues, unknown>> = {}
  for (const [key, allowed] of Object.entries(ALLOWED) as [keyof AppearanceValues, readonly unknown[]][]) {
    if (allowed.includes(src[key])) out[key] = src[key]
  }
  const hue = src.accentHue
  if (typeof hue === "number" && Number.isFinite(hue)) out.accentHue = Math.min(360, Math.max(0, Math.round(hue)))
  if (typeof src.glassEffect === "boolean") out.glassEffect = src.glassEffect
  return out as Partial<AppearanceValues>
}

/**
 * 解析一份外观配置；兼容旧版的 `{ preset, custom }`
 * @param parsed JSON 解析结果
 * @returns 完整参数，缺项取默认
 */
function parseAppearance(parsed: unknown): AppearanceValues {
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_VALUES }
  const obj = parsed as { values?: unknown; preset?: unknown; custom?: unknown }
  if ("values" in obj) return { ...DEFAULT_VALUES, ...sanitizeValues(obj.values) }
  const legacy = LAYOUT_PRESETS.find(p => p.id === obj.preset)?.values
  return { ...DEFAULT_VALUES, ...legacy, ...sanitizeValues(obj.custom) }
}

/**
 * 解析落盘的外观配置
 * @param raw 原始字符串
 * @returns 完整参数；格式错误或取值非法时退回默认
 */
export function readAppearance(raw: string | null): AppearanceValues {
  if (raw === null || raw === "") return { ...DEFAULT_VALUES }
  try {
    return parseAppearance(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_VALUES }
  }
}

/**
 * 取值对应的视觉方案
 * @param values 外观参数
 * @returns 方案标识；对不上任何方案时为 `CUSTOM`
 */
export function layoutPresetOf(values: AppearanceValues): LayoutPresetId | typeof CUSTOM {
  return LAYOUT_PRESETS.find(p => LAYOUT_KEYS.every(k => p.values[k] === values[k]))?.id ?? CUSTOM
}

/**
 * 取值对应的配色方案
 * @param values 外观参数
 * @returns 方案标识；对不上任何方案时为 `CUSTOM`
 */
export function colorPresetOf(values: AppearanceValues): ColorPresetId | typeof CUSTOM {
  return COLOR_PRESETS.find(p => p.hue === values.accentHue)?.id ?? CUSTOM
}

/**
 * 由外观参数算出 CSS 变量
 * @param values 外观参数
 * @returns 变量名到取值
 */
export function cssVariablesOf(values: AppearanceValues): Record<string, string> {
  const radius = RADIUS_MAP[values.radius]
  const density = DENSITY_MAP[values.density]
  const font = FONT_MAP[values.fontScale]
  const dur = MOTION_MAP[values.motion]
  const vars: Record<string, string> = {
    "--r-card": radius.card,
    "--r-ctl": radius.ctl,
    "--density-factor": String(density),
    "--accent-hue": String(values.accentHue),
    "--content-max": WIDTH_MAP[values.width]
  }
  for (let i = 1; i <= 6; i++) vars[`--s${i}`] = `${Math.round(4 * i * density)}px`
  for (const [name, size] of Object.entries(FONT_BASE)) vars[`--fs-${name}`] = `${Math.round(size * font * 2) / 2}px`
  dur.forEach((ms, i) => (vars[`--dur-${i + 1}`] = `${ms}ms`))
  return vars
}

/**
 * 写到 `<html>` 上
 * @param values 外观参数
 */
function apply(values: AppearanceValues): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(cssVariablesOf(values))) root.style.setProperty(key, value)
  root.dataset.motion = values.motion
  root.dataset.backdrop = values.backdrop
  root.dataset.glass = values.glassEffect ? "on" : "off"
}

/** 当前生效的外观参数 */
export const appearanceValues = ref<AppearanceValues>({ ...DEFAULT_VALUES })

/**
 * 套用一套视觉方案；强调色与动效不动
 * @param id 方案标识
 */
export function applyLayoutPreset(id: LayoutPresetId): void {
  const preset = LAYOUT_PRESETS.find(p => p.id === id)
  if (preset !== undefined) appearanceValues.value = { ...appearanceValues.value, ...preset.values }
}

/**
 * 套用一套配色方案；只改强调色
 * @param id 方案标识
 */
export function applyColorPreset(id: ColorPresetId): void {
  const preset = COLOR_PRESETS.find(p => p.id === id)
  if (preset !== undefined) appearanceValues.value = { ...appearanceValues.value, accentHue: preset.hue }
}

/**
 * 改一项参数
 * @param key 参数名
 * @param value 参数值
 */
export function updateValue<K extends keyof AppearanceValues>(key: K, value: AppearanceValues[K]): void {
  appearanceValues.value = { ...appearanceValues.value, [key]: value }
}

/** 全部恢复默认 */
export function resetAppearance(): void {
  appearanceValues.value = { ...DEFAULT_VALUES }
}

/**
 * 当前配置的 JSON 文本，供导出
 * @returns JSON
 */
export function exportAppearance(): string {
  return JSON.stringify({ values: appearanceValues.value }, null, 2)
}

/**
 * 导入一份配置
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
  if (typeof parsed !== "object" || parsed === null) return false
  appearanceValues.value = parseAppearance(parsed)
  return true
}

/**
 * 当前是否播放动画；外观页关闭动效或系统要求减少动效时为假
 * @returns 是否播放
 */
export function motionEnabled(): boolean {
  if (appearanceValues.value.motion === "off") return false
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** 落盘当前配置；浏览器禁止本地存储时只在本次会话内生效 */
function save(values: AppearanceValues): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ values }))
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
  appearanceValues.value = readAppearance(raw)

  watch(
    appearanceValues,
    values => {
      apply(values)
      save(values)
    },
    { immediate: true }
  )
}
