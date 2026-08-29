/**
 * 模块职责：cron 表达式的分段拆合与「下次触发时刻」推算
 * 依赖方向：无依赖，纯函数
 * 生命周期：无状态
 * 注意事项：**推算须与内核的 croner 同规则，否则预览会骗人。** 两处与直觉不同：
 *
 *          1. **六段时首段是秒**，五段时无秒段（等同于秒为 0）。
 *          2. **「日」与「周」是「或」而非「与」**（croner 的 `legacyMode` 默认为真，
 *             规则来自 vixie cron）：两段都不是 `*` 时取并集，其中一段为 `*` 时
 *             退化为另一段单独决定。写成「与」会使预览完全错位。
 *
 *          **看不懂就明说，不猜。** `L`（月末）、`#`（第 n 个星期几）、`?` 三种高级写法
 *          一律不推算并给出原因 —— 猜错的预览比没有预览有害，因为它看起来是答案。
 *
 *          推算按**浏览器所在时区**（配置字段只是一个表达式，不携带时区），界面上注明。
 */

/** 一段 cron 字段的定义 */
export interface CronFieldDef {
  /** 中文标签 */
  label: string
  /** 允许的取值范围，供提示 */
  range: string
  /** 是否可留空（仅秒段可留空，留空即五段写法） */
  optional?: boolean
}

/**
 * 六个字段的定义，顺序即六段写法的顺序
 *
 * 秒段列在首位且可留空：croner 的两种合法形态恰是「五段」与「秒 + 五段」，
 * 六个输入框加「秒段留空即五段」两种都能表达。
 */
export const CRON_FIELDS: readonly CronFieldDef[] = [
  { label: "秒", range: "0-59", optional: true },
  { label: "分", range: "0-59" },
  { label: "时", range: "0-23" },
  { label: "日", range: "1-31" },
  { label: "月", range: "1-12" },
  { label: "周", range: "0-7，0 与 7 均为周日" }
]

/** 推算结果 */
export interface CronPreview {
  /** 是否推算成功 */
  ok: boolean
  /** 接下来的触发时刻（毫秒时间戳），升序；失败时为空 */
  times: number[]
  /** 失败或推算不出时的原因 */
  reason?: string
}

/** 月份英文名 */
const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
}

/** 星期英文名 */
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/**
 * 往后最多找多少天
 *
 * 四年覆盖闰年：`0 0 29 2 *` 最长要等三年多。超过仍找不到即永不触发（如 `0 0 30 2 *`）。
 */
const MAX_DAYS = 366 * 4

/**
 * 高级写法：本模块不推算
 *
 * `L` 与 `W` 须为独立字母才算 —— 否则 `WED` 这类拼错的星期名（`WEDX`）会被误报为
 * 「含高级写法」，而它其实只是写错了，两者该给的提示不同。
 */
const ADVANCED = /(?:^|[^a-z])[lw](?:[^a-z]|$)|[#?]/i

/**
 * 按空白切分表达式
 * @param expr 表达式
 * @returns 各段；空表达式得到空数组
 */
export function splitCron(expr: string): string[] {
  const text = expr.trim()
  return text === "" ? [] : text.split(/\s+/)
}

/**
 * 把六个输入框的内容合成表达式
 *
 * 秒段留空即产出五段；其余各段留空按 `*` 计（只填「时」「分」意为「每天的这个时刻」）。
 * 全部留空则返回空串，不凭空造出 `* * * * *` —— 那是「每分钟」，与「尚未填写」是两回事。
 * @param parts 六段内容，顺序同 `CRON_FIELDS`
 * @returns 表达式；全部留空时为空串
 */
export function joinCron(parts: readonly string[]): string {
  const clean = CRON_FIELDS.map((_, i) => (parts[i] ?? "").trim())
  if (clean.every(part => part === "")) return ""
  const second = clean[0] ?? ""
  const rest = clean.slice(1).map(part => (part === "" ? "*" : part))
  return second === "" ? rest.join(" ") : [second, ...rest].join(" ")
}

/**
 * 把表达式摊回六个输入框
 *
 * 五段表达式的秒段留空，与 `joinCron` 互为逆操作。段数既非 5 也非 6 时原样铺开，
 * 使用者仍能看见并改正自己写下的内容，不清空重填。
 * @param expr 表达式
 * @returns 六段内容，顺序同 `CRON_FIELDS`
 */
export function explodeCron(expr: string): string[] {
  const parts = splitCron(expr)
  if (parts.length === 6) return parts
  if (parts.length === 5) return ["", ...parts]
  const out = ["", "", "", "", "", ""]
  for (let i = 0; i < parts.length && i < out.length; i++) out[i] = parts[i] ?? ""
  return out
}

/**
 * 把字段里的英文名换成数字
 * @param field 字段原文
 * @param names 名称表
 * @returns 替换后的文本
 */
function replaceNames(field: string, names: Record<string, number> | undefined): string {
  if (names === undefined) return field
  return field.replace(/[a-z]{3,}/gi, matched => {
    const found = names[matched.toLowerCase()]
    return found === undefined ? matched : String(found)
  })
}

/**
 * 解析一段字段为取值集合
 *
 * 支持四种写法及其逗号列表：`*`（全部）、`5`（单值）、`1-5`（区间），以及在其后
 * 以斜杠附加步长（`1-9` 加步长 2 得 1、3、5、7、9；单值加步长意为「自该值起每 n 个」）。
 * @param field 字段原文
 * @param min 下界
 * @param max 上界
 * @param names 英文名表
 * @returns 取值集合；无法解析时 undefined
 */
function parseField(field: string, min: number, max: number, names?: Record<string, number>): Set<number> | undefined {
  const text = replaceNames(field.trim(), names)
  if (text === "") return undefined
  const out = new Set<number>()

  for (const term of text.split(",")) {
    const [body, stepText, ...extra] = term.split("/")
    if (extra.length > 0 || body === undefined) return undefined

    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return undefined
      step = Number(stepText)
      if (step <= 0) return undefined
    }

    let from: number
    let to: number
    if (body === "*") {
      from = min
      to = max
    } else if (/^\d+$/.test(body)) {
      from = Number(body)
      // `5/2` 意为「自 5 起每 2 个」，而单独的 `5` 只是 5 本身
      to = stepText === undefined ? from : max
    } else {
      const ranged = /^(\d+)-(\d+)$/.exec(body)
      if (ranged === null) return undefined
      from = Number(ranged[1])
      to = Number(ranged[2])
    }

    if (from < min || from > max || to < min || to > max || from > to) return undefined
    for (let value = from; value <= to; value += step) out.add(value)
  }

  return out.size === 0 ? undefined : out
}

/**
 * 解析星期段
 *
 * 单独处理是因为它有一个别处没有的规则：7 与 0 都表示周日，须归一，
 * 否则 `0 0 * * 7` 会被算成「不存在的第八天」而永不触发。
 * @param field 字段原文
 * @returns 取值集合（0–6）；无法解析时 undefined
 */
function parseWeekday(field: string): Set<number> | undefined {
  const raw = parseField(field, 0, 7, DOW_NAMES)
  if (raw === undefined) return undefined
  const out = new Set<number>()
  for (const value of raw) out.add(value === 7 ? 0 : value)
  return out
}

/**
 * 推算接下来的若干个触发时刻
 * @param expr cron 表达式
 * @param from 起算时刻（毫秒时间戳），结果一律**晚于**它
 * @param count 要几个
 * @returns 推算结果
 */
export function previewCron(expr: string, from: number, count = 3): CronPreview {
  const parts = splitCron(expr)
  if (parts.length === 0) return { ok: false, times: [], reason: "尚未填写" }
  if (parts.length !== 5 && parts.length !== 6) {
    return { ok: false, times: [], reason: `表达式应为 5 段或 6 段，当前 ${parts.length} 段` }
  }

  const six = parts.length === 6 ? parts : ["0", ...parts]
  const specs: Array<{ text: string; set: Set<number> | undefined }> = [
    { text: six[0] ?? "", set: parseField(six[0] ?? "", 0, 59) },
    { text: six[1] ?? "", set: parseField(six[1] ?? "", 0, 59) },
    { text: six[2] ?? "", set: parseField(six[2] ?? "", 0, 23) },
    { text: six[3] ?? "", set: parseField(six[3] ?? "", 1, 31) },
    { text: six[4] ?? "", set: parseField(six[4] ?? "", 1, 12, MONTH_NAMES) },
    { text: six[5] ?? "", set: parseWeekday(six[5] ?? "") }
  ]

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    if (spec === undefined || spec.set !== undefined) continue
    const label = CRON_FIELDS[i]?.label ?? "某"
    // 先分辨「高级写法」与「写错了」：两者的下一步动作完全不同
    const reason = ADVANCED.test(replaceNames(spec.text, i === 4 ? MONTH_NAMES : i === 5 ? DOW_NAMES : undefined))
      ? `「${label}」段含 L / W / # / ? 等高级写法，此处不推算；内核仍会按其规则执行`
      : `「${label}」段无法识别：${spec.text}`
    return { ok: false, times: [], reason }
  }

  const seconds = [...(specs[0]?.set ?? [])].sort((a, b) => a - b)
  const minutes = [...(specs[1]?.set ?? [])].sort((a, b) => a - b)
  const hours = [...(specs[2]?.set ?? [])].sort((a, b) => a - b)
  const days = specs[3]?.set ?? new Set<number>()
  const months = specs[4]?.set ?? new Set<number>()
  const weekdays = specs[5]?.set ?? new Set<number>()

  // 见文件头第 2 点：两段都受限时取并集，否则取交集（此时其中一段恒为真）
  const dayStar = (six[3] ?? "").trim() === "*"
  const weekStar = (six[5] ?? "").trim() === "*"
  const union = !dayStar && !weekStar

  const start = new Date(from)
  const times: number[] = []

  for (let offset = 0; offset <= MAX_DAYS && times.length < count; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    if (!months.has(day.getMonth() + 1)) continue
    const dayOk = days.has(day.getDate())
    const weekOk = weekdays.has(day.getDay())
    if (!(union ? dayOk || weekOk : dayOk && weekOk)) continue

    // 当天只看起算时刻之后的部分。此处先做整数比较再建 Date：
    // `* * * * * *`（每秒）在当天有 86400 个候选，逐个建 Date 是白费的
    const sameDay = offset === 0
    const floor = sameDay ? start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds() : -1

    for (const hour of hours) {
      for (const minute of minutes) {
        for (const second of seconds) {
          if (hour * 3600 + minute * 60 + second <= floor) continue
          times.push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, second).getTime())
          if (times.length >= count) break
        }
        if (times.length >= count) break
      }
      if (times.length >= count) break
    }
  }

  if (times.length === 0) {
    return { ok: false, times: [], reason: "未来四年内不会触发，请检查日与月的组合" }
  }
  return { ok: true, times }
}
