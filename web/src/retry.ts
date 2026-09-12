/**
 * 模块职责：每账号重连覆盖（`AccountRecord.retry`）的表单态 —— 与内核三态的往返、以及摘要文案
 * 依赖方向：依赖 duration 与 types 的类型声明，纯函数
 * 生命周期：无状态
 * 注意事项：**「留空」是这张表单里最要紧的一个状态，它的意思是「跟随全局」而不是 0。**
 *          内核逐字段回落（`AccountManager.#policyOf`）：账号填了哪项就用哪项，没填的各自
 *          取全局配置 `adapter.*` 的同名项。若把留空当 0 送上去，`limit: 0` 是「一直重连」、
 *          `interval: 0` 是「不等待、立刻重试」—— 两者都是合法取值，于是一次「我没填这项」
 *          会变成一条实际生效的策略，而界面上看不出与「没填」的区别。
 *
 *          故四项一律以**字符串**存在表单里，`""` 即未填。用 number 表达不了这件事 ——
 *          `0` 与「没填」在 number 里是两个值，而在输入框里是同一个空格子。
 *
 *          **三态都要能送回去**：对象（有覆盖）、`null`（清掉覆盖、回到跟随全局）、以及
 *          调用方不提这一项（这次不动它）。少了 `null` 那一条，一个填过上限的账号就再没有
 *          回到全局缺省的途径，界面上那句「留空即跟随全局」会变成假话。
 *
 *          **填错的值原样回送，不在这里拦。** 判据只该有一处 —— 内核 `api.ts` 的
 *          `retryOverrideOf`（区间、时长格式、负数）。面板自备一套校验的两种错法都更糟：
 *          比内核严会让一个合法取值填不进去，比内核松则什么也没挡住；而把读不懂的值
 *          **悄悄丢掉**等于替使用者改了配置。回送之后内核会给出指名到字段的 400。
 */
import { DUR_UNITS, joinDuration, splitDuration, type DurationUnit } from "./duration.js"
import type { AccountRetryOverride, DurationLike } from "./types.js"

/** 四项的标识 */
export type RetryField = "limit" | "interval" | "maxInterval" | "factor"

/**
 * 编辑框里的重连覆盖
 *
 * 两项时长各占两格（数值 + 单位），故有六个字段。单位即便在数值为空时也有值 ——
 * 下拉不存在「没选」这个状态，而它在数值为空时不参与提交。
 */
export interface RetryForm {
  /** 重连次数上限；空串即跟随全局 */
  limit: string
  /** 首次重连间隔的数值部分；空串即跟随全局 */
  interval: string
  /** 首次重连间隔的单位 */
  intervalUnit: DurationUnit
  /** 重连间隔上限的数值部分；空串即跟随全局 */
  maxInterval: string
  /** 重连间隔上限的单位 */
  maxIntervalUnit: DurationUnit
  /** 退避倍率；空串即跟随全局 */
  factor: string
}

/**
 * 送往 `PATCH accounts/:id` 的覆盖
 *
 * 比 `AccountRetryOverride` 宽：四项都容得下字符串，因为**填错的值原样回送**交内核判
 * （见文件头最后一条）。这不是类型偷懒，是「判据只有一处」的必要代价 —— 收窄到
 * `AccountRetryOverride` 就得在这里先判一遍，而那就是第二处判据。
 */
export interface RetryPayload {
  /** 重连次数上限 */
  limit?: number | string
  /** 首次重连间隔 */
  interval?: DurationLike | string
  /** 重连间隔上限 */
  maxInterval?: DurationLike | string
  /** 退避倍率 */
  factor?: number | string
}

/**
 * 全局那四项的当前值，取自内核配置的 `adapter` 一节；读不到的项缺席
 *
 * 与每账号的覆盖同一个形状，故直接取内核的类型 —— 两者确实是同一组字段，各写一份的
 * 症状是内核加了第五项而界面只认得四项，且不报错。
 */
export type GlobalRetry = AccountRetryOverride

/**
 * 数值为空时单位取什么
 *
 * 取「秒」而非「毫秒」：这两项的缺省是 `2s` 与 `1m`，而人想给某个号单独设间隔时
 * 说的是「再等十秒」而不是「再等一万毫秒」。毫秒留在下拉里供读回已有值。
 */
const DEFAULT_UNIT: DurationUnit = "s"

/**
 * 把已存的覆盖铺成表单
 *
 * 读不懂的时长**原样落进数值格**（而非丢掉）：那个值是谁写进去的不得而知，但抹掉它
 * 一定不对。提交时它会被原样送回，由内核给出说法。
 * @param retry 账号记录里的 `retry`；没有覆盖时 undefined
 * @returns 表单态，四项各自可为空串
 */
export function retryFormOf(retry: AccountRetryOverride | undefined): RetryForm {
  const interval = splitDuration(retry?.interval)
  const maxInterval = splitDuration(retry?.maxInterval)
  return {
    limit: retry?.limit === undefined ? "" : String(retry.limit),
    interval: interval?.n === undefined ? textOf(retry?.interval) : String(interval.n),
    intervalUnit: interval?.unit ?? DEFAULT_UNIT,
    maxInterval: maxInterval?.n === undefined ? textOf(retry?.maxInterval) : String(maxInterval.n),
    maxIntervalUnit: maxInterval?.unit ?? DEFAULT_UNIT,
    factor: retry?.factor === undefined ? "" : String(retry.factor)
  }
}

/**
 * 把表单收成请求体里的那一项
 *
 * **四项全空时返回 `null`**，那正是内核的「清掉覆盖、回到跟随全局」。返回空对象是不行的：
 * 内核 `create()` 会把空对象当没填（`Object.keys(retry).length > 0` 才存），而 `update()`
 * 会把 `{}` 存成一个存在但为空的 `retry` —— 于是「这个号有没有自定义」的判断从此含糊。
 * @param form 表单态
 * @returns 覆盖对象；四项全空时 null
 */
export function retryOverrideOf(form: RetryForm): RetryPayload | null {
  const payload: RetryPayload = {}
  const limit = numberOf(form.limit)
  if (limit !== undefined) payload.limit = limit
  const factor = numberOf(form.factor)
  if (factor !== undefined) payload.factor = factor
  const interval = durationOf(form.interval, form.intervalUnit)
  if (interval !== undefined) payload.interval = interval
  const maxInterval = durationOf(form.maxInterval, form.maxIntervalUnit)
  if (maxInterval !== undefined) payload.maxInterval = maxInterval
  return Object.keys(payload).length === 0 ? null : payload
}

/**
 * 这个账号有没有自己的重连策略
 *
 * 判键数而非判 `!== undefined`：一个空对象在内核那侧与「没填」等价（`#policyOf` 取
 * `record.retry ?? {}`，两者算出的策略一模一样），界面上却会因此多出一枚徽标。
 * @param retry 账号记录里的 `retry`
 * @returns 是否存在至少一项覆盖
 */
export function isRetryCustom(retry: AccountRetryOverride | undefined): boolean {
  return retry !== undefined && Object.keys(retry).length > 0
}

/**
 * 把覆盖说成一行字
 *
 * **只说填了的那几项**，不把跟随全局的项也列出来：列了就读不出「哪几项是这个号自己的」，
 * 而那恰是看这行字的理由 —— 「这个号为什么不重试了」的答案只可能在填了的项里。
 * @param retry 账号记录里的 `retry`
 * @returns 摘要；没有任何覆盖时空串
 */
export function retrySummary(retry: AccountRetryOverride | undefined): string {
  if (!isRetryCustom(retry) || retry === undefined) return ""
  const parts: string[] = []
  if (retry.limit !== undefined) parts.push(retry.limit === 0 ? "一直重连" : `最多 ${retry.limit} 次`)
  if (retry.interval !== undefined) parts.push(`首次等 ${durationText(retry.interval)}`)
  if (retry.maxInterval !== undefined) parts.push(`最长等 ${durationText(retry.maxInterval)}`)
  if (retry.factor !== undefined) parts.push(`倍率 ${retry.factor}`)
  return parts.join(" · ")
}

/**
 * 「留空即跟随全局」那句，尽量带上全局此刻的值
 *
 * 带上那个数才使这句话可用：使用者要决定「这一项要不要自己填」，而没有全局值作参照
 * 就无从判断 —— 尤其 `limit` 的 0 是「一直重连」而不是「不重连」，不说出来必被读反。
 * 读不到全局值时退成那半句，绝不编一个数上去。
 * @param field 哪一项
 * @param global 全局四项的当前值
 * @returns 提示文案
 */
export function globalNote(field: RetryField, global: GlobalRetry): string {
  const shown = globalValueText(field, global)
  return shown === undefined ? "留空即跟随全局设置" : `留空即跟随全局设置，当前为 ${shown}`
}

/**
 * 从内核配置里挑出重连那四项
 *
 * **只挑四项，不把整份配置留在调用方手上。** `GET config/:name` 刻意不脱敏（面板要能
 * 显示与轮换面板令牌、要能显示适配器的连接密钥），响应体里带着 `server.token`。
 * 账号页要的只是四个数，没有理由让其余部分在那一页的状态里多待一秒。
 *
 * 形状不对的项一律当缺席：这份值来自使用者可以手改的 yaml，而 `globalNote` 的用途是
 * 给出一个可信的参照 —— 把 `reconnectInterval: 一会儿` 原样显示出来只会添乱。
 * @param value `GET config/yunzai` 的 `value`
 * @returns 四项；读不到的项缺席
 */
export function globalRetryOf(value: unknown): GlobalRetry {
  const adapter = recordOf(value)?.adapter
  const src = recordOf(adapter)
  if (src === undefined) return {}
  const out: GlobalRetry = {}
  if (typeof src.reconnectLimit === "number") out.limit = src.reconnectLimit
  if (typeof src.reconnectFactor === "number") out.factor = src.reconnectFactor
  if (splitDuration(src.reconnectInterval) !== undefined) out.interval = src.reconnectInterval as DurationLike
  if (splitDuration(src.reconnectMaxInterval) !== undefined) out.maxInterval = src.reconnectMaxInterval as DurationLike
  return out
}

/**
 * 某一项全局值的人话
 * @param field 哪一项
 * @param global 全局四项
 * @returns 文案；该项读不到时 undefined
 */
function globalValueText(field: RetryField, global: GlobalRetry): string | undefined {
  if (field === "limit") {
    if (global.limit === undefined) return undefined
    // 0 是「一直重连」而非「不重连」—— 这是此处最容易被读反的一个值，必须写出来
    return global.limit === 0 ? "0，即一直重连" : `${global.limit} 次`
  }
  if (field === "factor") return global.factor === undefined ? undefined : String(global.factor)
  const value = global[field]
  return value === undefined ? undefined : durationText(value)
}

/**
 * 时长值 → 中文
 * @param value 时长值
 * @returns 如 `2 秒`；读不懂时原样
 */
function durationText(value: DurationLike): string {
  const parts = splitDuration(value)
  if (parts === undefined) return String(value)
  return `${parts.n} ${DUR_UNITS.find(item => item.value === parts.unit)?.label ?? parts.unit}`
}

/**
 * 输入框内容 → 数字
 *
 * 非数字**原样回送**而不是丢掉，与 `SchemaField` 的 `setNumber` 同一个道理：丢掉等于
 * 把一次填错静默变成「这一项跟随全局」，而回送换来内核一句指名到字段的 400。
 * @param text 输入框内容
 * @returns 数字或原文；空串时 undefined
 */
function numberOf(text: string): number | string | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : trimmed
}

/**
 * 数值与单位 → 时长值
 * @param text 数值输入框的内容
 * @param unit 单位
 * @returns 时长值；拼不出来时退回原文，空串时 undefined
 */
function durationOf(text: string, unit: DurationUnit): DurationLike | string | undefined {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  return joinDuration(trimmed, unit) ?? trimmed
}

/**
 * 值 → 字符串，undefined 给空串
 * @param value 任意值
 * @returns 字符串
 */
function textOf(value: unknown): string {
  return value === undefined || value === null ? "" : String(value)
}

/**
 * 收窄成普通对象
 * @param value 任意值
 * @returns 对象；不是对象时 undefined
 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
