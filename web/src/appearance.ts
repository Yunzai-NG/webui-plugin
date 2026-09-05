/**
 * 模块职责：外观配置 —— 预设方案、自定义参数、持久化与 CSS 变量应用
 * 依赖方向：依赖 vue 的 ref / watch 与 localStorage
 * 生命周期：模块级单例；`initAppearance()` 在 `main.ts` 里调一次
 * 注意事项：**通过 CSS 变量驱动样式变化**，而非切换 class 或重新加载样式表。
 *          这样自定义参数可以实时生效，不需要刷新页面。
 *
 *          **预设方案是一组完整的 CSS 变量值**，选择预设后立即应用；
 *          自定义参数会覆盖预设中的对应变量，实现混合使用。
 */
import { ref, watch } from "vue"

/** 外观配置在 localStorage 中的键 */
export const APPEARANCE_KEY = "yunzai-ng.appearance"

/** 预设方案标识 */
export type PresetId = "default" | "compact" | "comfortable"

/** 外观预设方案 */
export interface AppearancePreset {
  id: PresetId
  name: string
  description: string
  values: AppearanceValues
}

/** 可自定义的外观参数 */
export interface AppearanceValues {
  /** 圆角大小：small | medium | large */
  radius: "small" | "medium" | "large"
  /** 密度：compact | normal | comfortable */
  density: "compact" | "normal" | "comfortable"
  /** 强调色色相（0-360） */
  accentHue: number
  /** 是否启用玻璃拟态效果 */
  glassEffect: boolean
}

/** 圆角档位对应的 CSS 变量值 */
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

/** 预设方案定义 */
export const PRESETS: readonly AppearancePreset[] = [
  {
    id: "default",
    name: "默认",
    description: "平衡的视觉与空间，适合大多数场景",
    values: {
      radius: "medium",
      density: "normal",
      accentHue: 239,
      glassEffect: false
    }
  },
  {
    id: "compact",
    name: "紧凑",
    description: "更小的圆角与间距，适合信息密集的工作台",
    values: {
      radius: "small",
      density: "compact",
      accentHue: 239,
      glassEffect: false
    }
  },
  {
    id: "comfortable",
    name: "舒适",
    description: "更大的圆角与间距，阅读体验更佳",
    values: {
      radius: "large",
      density: "comfortable",
      accentHue: 239,
      glassEffect: true
    }
  }
]

/** 默认外观参数 */
const DEFAULT_VALUES: AppearanceValues = {
  radius: "medium",
  density: "normal",
  accentHue: 239,
  glassEffect: false
}

/**
 * 从 localStorage 读取外观配置
 * @param raw 原始字符串
 * @returns 解析后的配置，格式错误时返回默认值
 */
export function readAppearance(raw: string | null): { preset: PresetId; custom: Partial<AppearanceValues> } {
  if (!raw) return { preset: "default", custom: {} }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") {
      return {
        preset: parsed.preset || "default",
        custom: parsed.custom || {}
      }
    }
  } catch {
    // 解析失败，使用默认值
  }
  return { preset: "default", custom: {} }
}

/**
 * 合并预设与自定义参数
 * @param preset 预设方案
 * @param custom 自定义参数
 * @returns 合并后的完整参数
 */
function mergeValues(preset: AppearancePreset, custom: Partial<AppearanceValues>): AppearanceValues {
  return { ...preset.values, ...custom }
}

/**
 * 根据外观参数生成 CSS 变量
 * @param values 外观参数
 * @returns CSS 变量键值对
 */
function toCSSVariables(values: AppearanceValues): Record<string, string> {
  const radius = RADIUS_MAP[values.radius]
  const density = DENSITY_MAP[values.density]

  const vars: Record<string, string> = {
    "--r-card": radius.card,
    "--r-ctl": radius.ctl,
    "--density-factor": String(density),
    "--accent-hue": String(values.accentHue)
  }

  // 根据密度调整间距
  const baseSpacing = 4
  vars["--s1"] = `${Math.round(baseSpacing * density)}px`
  vars["--s2"] = `${Math.round(baseSpacing * 2 * density)}px`
  vars["--s3"] = `${Math.round(baseSpacing * 3 * density)}px`
  vars["--s4"] = `${Math.round(baseSpacing * 4 * density)}px`
  vars["--s5"] = `${Math.round(baseSpacing * 5 * density)}px`
  vars["--s6"] = `${Math.round(baseSpacing * 6 * density)}px`

  return vars
}

/**
 * 将 CSS 变量应用到 document.documentElement
 * @param vars CSS 变量键值对
 */
function applyCSSVariables(vars: Record<string, string>): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}

/**
 * 清除所有外观相关的 CSS 变量（恢复为 styles.css 中的默认值）
 */
function clearAppearanceCSSVariables(): void {
  const root = document.documentElement
  const keys = [
    "--r-card", "--r-ctl", "--density-factor", "--accent-hue",
    "--s1", "--s2", "--s3", "--s4", "--s5", "--s6"
  ]
  for (const key of keys) {
    root.style.removeProperty(key)
  }
}

/** 当前选中的预设方案 */
export const currentPreset = ref<PresetId>("default")

/** 自定义参数（覆盖预设中的对应项） */
export const customValues = ref<Partial<AppearanceValues>>({})

/** 实际生效的外观参数（预设 + 自定义合并） */
export const effectiveValues = ref<AppearanceValues>({ ...DEFAULT_VALUES })

/**
 * 选择预设方案
 * @param presetId 预设标识
 */
export function selectPreset(presetId: PresetId): void {
  currentPreset.value = presetId
  const preset = PRESETS.find(p => p.id === presetId)
  if (preset) {
    effectiveValues.value = mergeValues(preset, customValues.value)
  }
}

/**
 * 更新自定义参数
 * @param key 参数名
 * @param value 参数值
 */
export function updateCustomValue<K extends keyof AppearanceValues>(key: K, value: AppearanceValues[K]): void {
  customValues.value = { ...customValues.value, [key]: value }
  const preset = PRESETS.find(p => p.id === currentPreset.value)
  if (preset) {
    effectiveValues.value = mergeValues(preset, customValues.value)
  }
}

/**
 * 重置为默认外观
 */
export function resetAppearance(): void {
  currentPreset.value = "default"
  customValues.value = {}
  effectiveValues.value = { ...DEFAULT_VALUES }
}

/**
 * 落盘当前外观配置
 */
function save(): void {
  const data = {
    preset: currentPreset.value,
    custom: customValues.value
  }
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(data))
}

/**
 * 初始化外观配置
 *
 * 读取 localStorage 中的配置，应用 CSS 变量，并监听变化自动保存
 */
export function initAppearance(): void {
  const stored = readAppearance(localStorage.getItem(APPEARANCE_KEY))
  currentPreset.value = stored.preset
  customValues.value = stored.custom

  const preset = PRESETS.find(p => p.id === currentPreset.value)
  if (preset) {
    effectiveValues.value = mergeValues(preset, customValues.value)
  }

  // 监听变化，自动应用 CSS 变量并保存
  watch(effectiveValues, (values) => {
    const vars = toCSSVariables(values)
    applyCSSVariables(vars)
    save()
  }, { immediate: true })
}
