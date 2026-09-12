/**
 * 模块职责：时长的「数值 + 单位」拆解与复原 —— `"30s"` ⇄ `{ n: 30, unit: "s" }`
 * 依赖方向：只依赖 types 的类型声明，纯函数
 * 生命周期：无状态
 * 注意事项：**判据与内核的 `parseDuration` 必须是同一条**（`util/duration.ts` 里那条
 *          `DURATION_RE`）。各处自备一条正则的症状是「这个值面板收下了、内核却解析不出来」——
 *          而内核解析不出来时**静默回落到缺省值**，于是使用者看到的是「我明明填了 5 秒，
 *          它却按一分钟退避」。
 *
 *          **读不懂的写法一律返回 undefined，绝不按 0 呈现。** 配置文件里可能出现 `"1h30m"`
 *          这类内核也不接受、但确实会被人手写进去的值；强行拆成 `{ n: 0 }` 的后果是使用者
 *          一保存就把原值抹掉了 —— 而他并没有碰那个字段。调用方据此退回纯文本框。
 *
 *          **单位为毫秒时复原成数值而非 `"5ms"`。** 内核两种写法都收，而原本写作
 *          `cooldown: 0` 的项若被改写成 `"0ms"`，看起来像框架在乱改文件。
 */
import type { DurationLike } from "./types.js"

/** 时长单位标识 —— 与 `DurationLike` 的后缀一一对应 */
export type DurationUnit = "ms" | "s" | "m" | "h" | "d"

/** 一个可选单位 */
export interface DurationUnitItem {
  /** 写进表达式里的后缀 */
  value: DurationUnit
  /** 下拉里显示的中文 */
  label: string
}

/** 时长单位表；顺序即下拉中的顺序 */
export const DUR_UNITS: readonly DurationUnitItem[] = [
  { value: "ms", label: "毫秒" },
  { value: "s", label: "秒" },
  { value: "m", label: "分" },
  { value: "h", label: "时" },
  { value: "d", label: "天" }
]

/** 与内核 `util/duration.ts` 的 `DURATION_RE` 同一条 */
const DUR_RE = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d)$/

/**
 * 把一个时长值拆成数值与单位
 *
 * 收 `unknown` 而非 `DurationLike`：调用方手上的是从服务端来的任意值（配置文件里
 * 的内容没有类型保证），在这里收窄一次好过每个调用点各判一遍。
 * @param value 时长值：毫秒数、`"5000"` 这类纯数字串，或 `"30s"` 这类表达式
 * @returns 数值与单位；读不懂时 undefined
 */
export function splitDuration(value: unknown): { n: number; unit: DurationUnit } | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? { n: value, unit: "ms" } : undefined
  if (typeof value !== "string") return undefined
  const text = value.trim()
  // 纯数字串按毫秒收，与内核一致 —— YAML 里读出来的正是这种
  if (/^-?\d+$/.test(text)) return { n: Number(text), unit: "ms" }
  const matched = DUR_RE.exec(text)
  return matched === null ? undefined : { n: Number(matched[1]), unit: matched[2] as DurationUnit }
}

/**
 * 把数值与单位拼回时长值
 *
 * **空串与非数字都返回 undefined**，由调用方决定那意味着什么：配置表单里意味着「这次
 * 不提交」（字段本来就有值，清空不是一个可表达的意图），账号的重连覆盖里意味着
 * 「这一项跟随全局」。两者的处置相反，故不在这里替谁决定。
 *
 * 改单位时数值原样保留，不做等值换算：`5000` 毫秒换成秒该得 `5` 还是 `5000` 取决于
 * 使用者的意图，替其决定必有一半场合是错的，且错得静默。
 * @param text 数值输入框的内容
 * @param unit 单位；不在 `DUR_UNITS` 里时视为读不懂
 * @returns 时长值；填的东西用不了时 undefined
 */
export function joinDuration(text: string, unit: string): DurationLike | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return undefined
  const known = DUR_UNITS.find(item => item.value === unit)
  if (known === undefined) return undefined
  return known.value === "ms" ? n : `${n}${known.value}`
}
