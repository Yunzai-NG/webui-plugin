/**
 * 模块职责：主题的纯函数 —— 槽位到 CSS 变量、首帧缓存的形状、给扩展页的主题消息
 * 依赖方向：只依赖类型；不碰 document、localStorage、api（故可在 node 环境下测）
 * 生命周期：纯函数，无状态
 * 注意事项：与 themes.ts 分开只为能测，理由同 custombridgegate.ts：`api.ts` 模块级就读
 *          localStorage，与它同处一个文件的逻辑在 node 下一个都测不到。
 *
 *          **槽位落成两样东西**：CSS 变量（图片地址、边框切片）与 `<html data-slots>` 里的一串名字。
 *          样式表按「有没有这个槽位」挑规则（`[data-slots~="switch.thumb.on"]`），而不是
 *          判变量是否为空 —— CSS 里没有「这个变量有没有值」的判断。
 */
import type { SchemeMode } from "./scheme.js"

/** 九宫格边框 */
export interface FrameSlot {
  /** 图片地址 */
  image: string
  /** 切片像素 */
  slice: number
  /** 边框宽度 */
  width: string
  /** 向外扩出 */
  outset: string
  /** 平铺方式 */
  repeat: "stretch" | "repeat" | "round" | "space"
}

/** 一个槽位的值，与服务端 themescan.ts 的 `SlotValue` 同形 */
export type SlotValue = string | FrameSlot | { light?: string; dark?: string }

/** 服务端给的一条主题记录，字段与 themescan.ts 的 `ThemeInfo` 一一对应 */
export interface ThemeInfo {
  /** 主题 id */
  id: string
  /** 显示名 */
  name: string
  /** 一句话说明 */
  description: string
  /** 作者 */
  author: string
  /** 版本 */
  version: string
  /** 授权说明 */
  license: string
  /** 支持的明暗；空数组按两套都支持算 */
  schemes: SchemeMode[]
  /** 是否为 webui 自带 */
  builtin: boolean
  /** 来自哪个包；内置的没有 */
  pkg?: string
  /** 样式表地址；经典没有 */
  style?: string
  /** 脚本地址 */
  script?: string
  /** 预览图地址 */
  preview?: string
  /** 换掉的导航图标 */
  icons?: { mode: "stroke" | "image"; nav: Record<string, string> }
  /** 槽位 */
  slots: Partial<Record<string, SlotValue>>
  /** 允许使用者改的项 */
  options: { accentHue: boolean; radius: boolean; backdrop: boolean }
  /** 主题自己的缺省背景 */
  backdrop: "gradient" | "dots" | "plain" | "image"
}

/**
 * 经典主题：清单取回来之前、取不到时、安全模式下都按它算
 *
 * 它没有样式表 —— styles.css 本身就是它。
 */
export const CLASSIC: ThemeInfo = {
  id: "classic",
  name: "经典",
  description: "",
  author: "Yunzai-NG",
  version: "",
  license: "",
  schemes: ["light", "dark"],
  builtin: true,
  slots: {},
  options: { accentHue: true, radius: true, backdrop: true },
  backdrop: "gradient"
}

/** 首帧缓存的形状：index.html 的内联脚本只认这几项 */
export interface FirstPaint {
  /** 主题 id */
  id: string
  /** 样式表地址；经典没有 */
  css?: string
  /** 要写到 `<html>` 上的变量 */
  vars: Record<string, string>
  /** `data-slots` 的值 */
  slots: string
  /** 主题支持的明暗 */
  schemes: SchemeMode[]
}

/** 首帧缓存在 localStorage 中的键，与 index.html 的内联脚本一致 */
export const FIRST_PAINT_KEY = "yunzai-ng.theme-cache"

/**
 * 槽位名转成 CSS 变量名里能用的写法
 * @param name 槽位名，如 `switch.thumb.on`
 * @returns 如 `switch-thumb-on`
 */
export function slotKey(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-")
}

/**
 * 一个地址包成 `url()`
 * @param href 地址
 * @returns CSS 值
 */
function cssUrl(href: string): string {
  return `url("${href.replace(/["\\\n]/g, "")}")`
}

/**
 * 由槽位算出 CSS 变量与 `data-slots`
 *
 * 背景图分明暗两张时，按当前明暗取一张；只给了一张就两种明暗都用它。
 * @param slots 主题的槽位
 * @param scheme 当前明暗
 * @returns 变量与槽位名列表
 */
export function slotVarsOf(slots: ThemeInfo["slots"], scheme: SchemeMode): { vars: Record<string, string>; names: string[] } {
  const vars: Record<string, string> = {}
  const names: string[] = []
  for (const [name, value] of Object.entries(slots)) {
    if (value === undefined) continue
    const key = `--slot-${slotKey(name)}`
    if (typeof value === "string") {
      vars[key] = cssUrl(value)
    } else if ("image" in value) {
      vars[key] = cssUrl(value.image)
      vars[`${key}-slice`] = String(value.slice)
      vars[`${key}-width`] = value.width
      vars[`${key}-outset`] = value.outset
      vars[`${key}-repeat`] = value.repeat
    } else {
      const pick = scheme === "dark" ? (value.dark ?? value.light) : (value.light ?? value.dark)
      if (pick === undefined) continue
      vars[key] = cssUrl(pick)
    }
    names.push(name)
  }
  return { vars, names }
}

/**
 * 首帧缓存
 * @param theme 主题
 * @param scheme 当前明暗
 * @returns 缓存内容
 */
export function firstPaintOf(theme: ThemeInfo, scheme: SchemeMode): FirstPaint {
  const { vars, names } = slotVarsOf(theme.slots, scheme)
  return {
    id: theme.id,
    ...(theme.style === undefined ? {} : { css: theme.style }),
    vars,
    slots: names.join(" "),
    schemes: theme.schemes
  }
}

/**
 * 在主题表里找所选的那一款；找不到时依次退回站点默认与经典
 *
 * 卸掉了的主题不覆盖使用者的选择：重装回来时它照旧是那一款。
 * @param list 主题表
 * @param wanted 使用者选的 id
 * @param siteDefault 站点默认主题 id
 * @returns 实际生效的主题
 */
export function pickTheme(list: readonly ThemeInfo[], wanted: string | undefined, siteDefault: string): ThemeInfo {
  return (
    list.find(t => t.id === wanted) ?? list.find(t => t.id === siteDefault) ?? list.find(t => t.id === CLASSIC.id) ?? CLASSIC
  )
}

/** 给扩展页的主题消息的类型标识，与 theme-sdk.js 一致 */
export const THEME_BRIDGE_KIND = "yunzai-ng.theme"

/** 公开令牌：主题桥把这些变量的计算值发给扩展页，docs 的「设计令牌」一页逐项列着 */
export const PUBLIC_TOKENS = [
  "--bg",
  "--panel",
  "--raise",
  "--border",
  "--border-strong",
  "--text",
  "--muted",
  "--fg",
  "--line",
  "--accent",
  "--accent-solid",
  "--accent-2",
  "--on-accent",
  "--accent-glow",
  "--accent-hue",
  "--info",
  "--ok",
  "--warn",
  "--err",
  "--on-err",
  "--code-bg",
  "--font-ui",
  "--font-mono",
  "--fs-h1",
  "--fs-h2",
  "--fs-h3",
  "--fs-body",
  "--fs-hint",
  "--fs-label",
  "--s1",
  "--s2",
  "--s3",
  "--s4",
  "--s5",
  "--s6",
  "--s7",
  "--s8",
  "--r-card",
  "--r-ctl",
  "--r-pill",
  "--dur-1",
  "--dur-2",
  "--dur-3",
  "--ease",
  "--shadow-float",
  "--scrim",
  "--scrollbar-thumb",
  "--scrollbar-thumb-hover"
] as const

/** 给扩展页的一条主题消息 */
export interface ThemeMessage {
  /** 消息类型标识 */
  kind: typeof THEME_BRIDGE_KIND
  /** 主题 id */
  id: string
  /** 当前明暗 */
  scheme: SchemeMode
  /** 主题样式表的绝对地址；经典没有 */
  css?: string
  /** 公开令牌的计算值 */
  tokens: Record<string, string>
  /** 槽位：名字 → 图片绝对地址 */
  slots: Record<string, string>
  /** 低功耗 */
  lowPower: boolean
  /** 是否播放动效 */
  motion: boolean
}

/**
 * 拼一条主题消息
 *
 * 地址一律补成绝对的：扩展页的文档地址与面板不同，相对地址到了那边就指错了地方。
 * @param input 主题、明暗、令牌的计算值、面板的源与两个开关
 * @returns 主题消息
 */
export function themeMessageOf(input: {
  theme: ThemeInfo
  scheme: SchemeMode
  tokens: Record<string, string>
  origin: string
  lowPower: boolean
  motion: boolean
}): ThemeMessage {
  const abs = (href: string): string => (/^https?:\/\//.test(href) ? href : `${input.origin}${href}`)
  const slots: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.theme.slots)) {
    if (value === undefined) continue
    const href =
      typeof value === "string"
        ? value
        : "image" in value
          ? value.image
          : input.scheme === "dark"
            ? (value.dark ?? value.light)
            : (value.light ?? value.dark)
    if (href !== undefined) slots[name] = abs(href)
  }
  return {
    kind: THEME_BRIDGE_KIND,
    id: input.theme.id,
    scheme: input.scheme,
    ...(input.theme.style === undefined ? {} : { css: abs(input.theme.style) }),
    tokens: input.tokens,
    slots,
    lowPower: input.lowPower,
    motion: input.motion
  }
}
