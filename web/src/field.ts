/**
 * 模块职责：字段约束的人话化 —— 长度计数、取值范围、正则说明
 * 依赖方向：仅依赖类型
 * 生命周期：纯函数
 * 注意事项：`min` / `max` / `pattern` 一直在 `SchemaDescriptor` 里，但表单只把它们传给原生
 *          控件的同名属性，于是「取值范围 1 ~ 65535」只在保存失败后才以报错的形式出现。
 *          此处把它们在输入之前就摆出来。
 *
 *          **字数按码点计，与内核一致**（内核用 `[...text].length`）：改用 `text.length`
 *          则含表情符号的输入显示「2 / 20」而内核只算 1 个，计数器成了误导。数组按项数。
 *
 *          **正则只在认得出时才翻译。** 任意正则转中文做不到，硬做就会在不认识的形态上
 *          给出错误说明。故只认几种常见写法，其余返回 undefined，由界面照原样显示正则。
 */
import type { SchemaDescriptor } from "./types.js"

/** 长度计数 */
export interface LengthLimit {
  /** 已用字数或项数 */
  used: number
  /** 上限 */
  max: number
  /** 是否已超出 */
  over: boolean
  /** 单位名，「字」或「项」 */
  unit: string
}

/**
 * 取长度计数
 *
 * 仅在声明了 `max` 且字段确实按长度受限时给出：数值字段的 `max` 是**取值上界**
 * 而非长度，给它配一个「12 / 20」的计数器会被读成「还能再输入 8 位」。
 * @param schema 字段描述
 * @param value 当前值
 * @returns 计数；不适用时 undefined
 */
export function lengthLimitOf(schema: SchemaDescriptor, value: unknown): LengthLimit | undefined {
  const max = schema.max
  if (max === undefined) return undefined

  if (schema.type === "array") {
    const used = Array.isArray(value) ? value.length : 0
    return { used, max, over: used > max, unit: "项" }
  }
  if (schema.type === "string") {
    const used = typeof value === "string" ? [...value].length : 0
    return { used, max, over: used > max, unit: "字" }
  }
  return undefined
}

/**
 * 取值范围的一句话
 *
 * 措辞随类型而变：数值说「取值」，字符串说「长度」，数组说「项数」。内核写入 yaml
 * 注释时一律作「取值范围」，因为那里同一个函数要应付全部类型；此处知道类型，
 * 故可说得更准 —— 「长度 1 ~ 20」与「取值 1 ~ 20」在字符串字段上差得很远。
 * @param schema 字段描述
 * @returns 说明；未声明 min/max 时 undefined
 */
export function rangeTextOf(schema: SchemaDescriptor): string | undefined {
  const { min, max } = schema
  if (min === undefined && max === undefined) return undefined

  const noun = schema.type === "string" ? "长度" : schema.type === "array" ? "项数" : "取值"
  const span = min !== undefined && max !== undefined ? `${min} ~ ${max}` : min !== undefined ? `≥ ${min}` : `≤ ${max}`
  return `${noun} ${span}`
}

/** 一条可识别的正则形态 */
interface PatternRule {
  /** 匹配正则源文本本身的正则 */
  shape: RegExp
  /**
   * 由捕获组产出说明
   * @param groups 捕获组
   * @returns 中文说明
   */
  text: (groups: readonly (string | undefined)[]) => string
}

/**
 * 可识别的正则形态
 *
 * 逐条都要求以 `^` 起、以 `$` 止（或明确写出 `^` 的前缀形态）：缺少锚点的正则
 * 只要求「含有」而非「整体匹配」，说明的措辞完全不同，误当作整体匹配是会骗人的。
 */
const PATTERN_RULES: readonly PatternRule[] = [
  { shape: /^\^\\d\+\$$/, text: () => "只能是数字" },
  { shape: /^\^\\d\{(\d+)\}\$$/, text: g => `只能是数字，须为 ${g[0]} 位` },
  { shape: /^\^\\d\{(\d+),\}\$$/, text: g => `只能是数字，至少 ${g[0]} 位` },
  { shape: /^\^\\d\{(\d+),(\d+)\}\$$/, text: g => `只能是数字，${g[0]} 至 ${g[1]} 位` },
  { shape: /^\^\[0-9\]\+\$$/, text: () => "只能是数字" },
  { shape: /^\^\\w\+\$$/, text: () => "只能是字母、数字与下划线" },
  { shape: /^\^\[a-zA-Z0-9_-\]\+\$$/, text: () => "只能是字母、数字、下划线与连字符" },
  { shape: /^\^\[a-z0-9-\]\+\$$/, text: () => "只能是小写字母、数字与连字符" },
  { shape: /^\^https\?:\\?\/\\?\//, text: () => "须以 http:// 或 https:// 开头" },
  { shape: /^\^wss\?:\\?\/\\?\//, text: () => "须以 ws:// 或 wss:// 开头" },
  { shape: /^\^\\\/$/, text: () => "须以斜杠开头" }
]

/**
 * 把正则源文本翻成人话
 * @param source 正则源文本（`SchemaDescriptor.pattern`）
 * @returns 中文说明；认不出时 undefined
 */
export function describePattern(source: string): string | undefined {
  for (const rule of PATTERN_RULES) {
    const matched = rule.shape.exec(source)
    if (matched !== null) return rule.text(matched.slice(1))
  }
  return undefined
}
