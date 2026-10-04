/**
 * 模块职责：数据库页的纯逻辑 —— 前缀、值的文本往返、差异、命名空间占比、SQL 拼装、导出
 * 依赖方向：只依赖 types 的类型声明，纯函数
 * 生命周期：无状态
 * 注意事项：SQL 只拼标识符，值一律走绑定参数；筛选条件与控制台语句由使用者手写，原样交给内核。
 *
 *          `accounts:` 与 `adapter:` 下存有账号配置（含连接令牌），列表与详情默认隐藏。
 */
import type { KvValueType, SqlColumn, SqlTable } from "./types.js"

/** 命名空间分隔符，与内核 `Kv` 一致 */
const SEP = ":"

/** 默认隐去内容的前缀 */
const SENSITIVE = ["accounts:", "adapter:"]

/** 浏览表时 rowid 列的别名，避免与业务列重名 */
export const ROWID_ALIAS = "__rowid__"

/** 值大类的中文名 */
export const KV_TYPE_LABEL: Record<KvValueType, string> = {
  string: "字符串",
  number: "数字",
  boolean: "布尔",
  null: "空值",
  array: "数组",
  object: "对象"
}

/* ────────────────────────────── KV ────────────────────────────── */

/** 面包屑的一节 */
export interface Crumb {
  /** 显示文案 */
  label: string
  /** 点击后进入的前缀 */
  prefix: string
}

/**
 * 把前缀拆成面包屑
 * @param prefix 形如 `plugin:webui:` 的前缀
 * @returns 自根起的各节
 */
export function crumbsOf(prefix: string): Crumb[] {
  const out: Crumb[] = [{ label: "根", prefix: "" }]
  let acc = ""
  for (const part of prefix.split(SEP).slice(0, -1)) {
    acc += `${part}${SEP}`
    out.push({ label: part === "" ? "（空）" : part, prefix: acc })
  }
  return out
}

/**
 * 取上一级前缀
 * @param prefix 当前前缀
 * @returns 上一级前缀；已在根时为空串
 */
export function parentOf(prefix: string): string {
  const crumbs = crumbsOf(prefix)
  return crumbs[crumbs.length - 2]?.prefix ?? ""
}

/**
 * 键的内容是否默认隐去
 * @param key 完整键或前缀
 * @returns 是否敏感
 */
export function isSensitive(key: string): boolean {
  return SENSITIVE.some(p => key.startsWith(p))
}

/**
 * 判断值的大类，与内核检视器的判定一致
 * @param value 值
 * @returns 大类
 */
export function kvTypeOf(value: unknown): KvValueType {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return "array"
  const t = typeof value
  return t === "string" || t === "number" || t === "boolean" ? t : "object"
}

/**
 * 值经 JSON 序列化后的字节数
 * @param value 值
 * @returns 字节数
 */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").length
}

/** 值的编辑方式：JSON 或纯文本（存为字符串） */
export type ValueMode = "json" | "text"

/**
 * 为值选择默认编辑方式并转为文本
 * @param value 值
 * @returns 编辑方式与文本
 */
export function valueTextOf(value: unknown): { mode: ValueMode; text: string } {
  if (typeof value === "string") return { mode: "text", text: value }
  return { mode: "json", text: JSON.stringify(value, null, 2) ?? "null" }
}

/**
 * 将编辑框中的文本还原为值
 * @param text 文本
 * @param mode 编辑方式
 * @returns 值，或解析失败的原因
 */
export function parseValueText(text: string, mode: ValueMode): { ok: true; value: unknown } | { ok: false; error: string } {
  if (mode === "text") return { ok: true, value: text }
  if (text.trim() === "") return { ok: false, error: "JSON 不能为空；如需存储空字符串，请切换至「文本」" }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (err) {
    return { ok: false, error: `JSON 无效：${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 校验并重排 JSON 文本
 * @param text 文本
 * @param pretty 为真时缩进两格，否则压缩为一行
 * @returns 重排后的文本，或解析失败的原因
 */
export function reformatJson(text: string, pretty: boolean): { ok: true; text: string } | { ok: false; error: string } {
  const parsed = parseValueText(text, "json")
  if (!parsed.ok) return parsed
  return { ok: true, text: JSON.stringify(parsed.value, null, pretty ? 2 : undefined) ?? "null" }
}

/**
 * 将「N 秒后过期」换算为过期时间点
 * @param text 输入框内容；空串表示永不过期
 * @param now 当前毫秒时间戳
 * @returns 时间点；永不过期时 undefined；输入不是正数时 null
 */
export function expireAtOf(text: string, now: number): number | undefined | null {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  const sec = Number(trimmed)
  if (!Number.isFinite(sec) || sec <= 0) return null
  return now + Math.round(sec * 1000)
}

/**
 * 剩余存活时间的文案
 * @param expireAt 过期时间点；永不过期时 undefined
 * @param now 当前毫秒时间戳
 * @returns 如 `2小时3分后过期`；永不过期时为空串
 */
export function ttlText(expireAt: number | undefined, now: number): string {
  if (expireAt === undefined) return ""
  const left = Math.max(0, Math.round((expireAt - now) / 1000))
  if (left < 60) return `${left}秒后过期`
  const min = Math.floor(left / 60)
  if (min < 60) return `${min}分后过期`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}小时${min % 60}分后过期`
  return `${Math.floor(hour / 24)}天${hour % 24}小时后过期`
}

/** 一档过期预设 */
export interface TtlPreset {
  /** 按钮文案 */
  label: string
  /** 秒数 */
  sec: number
}

/** 过期预设，顺序即按钮顺序 */
export const TTL_PRESETS: readonly TtlPreset[] = [
  { label: "1 小时", sec: 3600 },
  { label: "1 天", sec: 86_400 },
  { label: "7 天", sec: 604_800 },
  { label: "30 天", sec: 2_592_000 }
]

/** 过期设置：保持原样、永不过期、自定义秒数，或某档预设的秒数 */
export type TtlChoice = "keep" | "never" | "custom" | number

/**
 * 由过期设置算出写入时的过期时间点
 * @param choice 过期设置
 * @param custom 自定义秒数的输入
 * @param current 键现有的过期时间点
 * @param now 当前毫秒时间戳
 * @returns 过期时间点（永不过期时 undefined），或输入无效的原因
 */
export function resolveExpireAt(
  choice: TtlChoice,
  custom: string,
  current: number | undefined,
  now: number
): { ok: true; expireAt: number | undefined } | { ok: false; error: string } {
  if (choice === "keep") return { ok: true, expireAt: current }
  if (choice === "never") return { ok: true, expireAt: undefined }
  if (typeof choice === "number") return { ok: true, expireAt: now + choice * 1000 }
  const at = expireAtOf(custom, now)
  if (at === undefined || at === null) return { ok: false, error: "自定义过期须填写正数秒数" }
  return { ok: true, expireAt: at }
}

/** 键列表的排序依据 */
export type KvSort = "name" | "size" | "expire"

/**
 * 排序键列表；永不过期的键按过期时间排在最后
 * @param items 键
 * @param by 排序依据
 * @param desc 是否降序
 * @returns 新数组
 */
export function sortKvItems<T extends { key: string; size: number; expireAt?: number }>(
  items: readonly T[],
  by: KvSort,
  desc: boolean
): T[] {
  const value = (item: T): number | string =>
    by === "name" ? item.key : by === "size" ? item.size : (item.expireAt ?? Number.POSITIVE_INFINITY)
  const sign = desc ? -1 : 1
  return [...items].sort((p, q) => {
    const a = value(p)
    const b = value(q)
    return a < b ? -sign : a > b ? sign : 0
  })
}

/* ────────────────────────────── 差异 ────────────────────────────── */

/** 差异中的一行 */
export interface DiffLine {
  /** 不变、新增或删除 */
  op: "same" | "add" | "del"
  /** 行文本 */
  text: string
}

/** 折叠后的差异项：一行，或一段省略的未改动行 */
export type DiffItem = DiffLine | { op: "gap"; count: number }

/** 逐行比较的单元格上限；超出时退化为整段删除加整段新增 */
const DIFF_CELLS = 4_000_000

/**
 * 按行比较两段文本（最长公共子序列）
 * @param before 原文
 * @param after 新文
 * @returns 逐行差异
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n")
  const b = after.split("\n")
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const out: DiffLine[] = a.slice(0, head).map(text => ({ op: "same", text }))
  const n = x.length
  const m = y.length

  if (n * m > DIFF_CELLS) {
    for (const text of x) out.push({ op: "del", text })
    for (const text of y) out.push({ op: "add", text })
  } else {
    const w = m + 1
    const dp = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push({ op: "same", text: x[i]! })
        i++
        j++
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        out.push({ op: "del", text: x[i++]! })
      } else {
        out.push({ op: "add", text: y[j++]! })
      }
    }
    while (i < n) out.push({ op: "del", text: x[i++]! })
    while (j < m) out.push({ op: "add", text: y[j++]! })
  }

  for (const text of a.slice(a.length - tail)) out.push({ op: "same", text })
  return out
}

/**
 * 折叠远离改动的未改动行
 * @param lines 逐行差异
 * @param context 改动前后各保留的行数
 * @returns 折叠后的差异项
 */
export function foldDiff(lines: readonly DiffLine[], context = 3): DiffItem[] {
  const near = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, i) => {
    if (line.op === "same") return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near[k] = true
  })
  const out: DiffItem[] = []
  let gap = 0
  lines.forEach((line, i) => {
    if (!near[i]) {
      gap++
      return
    }
    if (gap > 0) out.push({ op: "gap", count: gap })
    gap = 0
    out.push(line)
  })
  if (gap > 0) out.push({ op: "gap", count: gap })
  return out
}

/**
 * 统计差异的增删行数
 * @param lines 逐行差异
 * @returns 新增与删除行数
 */
export function diffStat(lines: readonly DiffLine[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of lines) {
    if (line.op === "add") add++
    else if (line.op === "del") del++
  }
  return { add, del }
}

/* ────────────────────────────── 命名空间占比 ────────────────────────────── */

/** 一个命名空间的占比 */
export interface Share {
  /** 命名空间名，含结尾 `:`；空串表示前缀下直属的键 */
  name: string
  /** 键数 */
  count: number
  /** 占比，0–1 */
  ratio: number
}

/**
 * 计算各命名空间的键数占比
 * @param groups 子命名空间
 * @param direct 直属键数
 * @returns 按键数降序的占比
 */
export function sharesOf(groups: readonly { name: string; count: number }[], direct = 0): Share[] {
  const all = direct > 0 ? [...groups, { name: "", count: direct }] : [...groups]
  const total = all.reduce((n, g) => n + g.count, 0)
  return all
    .map(g => ({ name: g.name, count: g.count, ratio: total === 0 ? 0 : g.count / total }))
    .sort((p, q) => q.count - p.count || (p.name < q.name ? -1 : p.name > q.name ? 1 : 0))
}

/* ────────────────────────────── SQL ────────────────────────────── */

/**
 * 为 SQLite 标识符加引号
 * @param name 表名或列名
 * @returns 带双引号的标识符
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** 浏览表数据的条件 */
export interface BrowseQuery {
  /** WHERE 子句的内容，由使用者填写 */
  where?: string
  /** 排序列；`ROWID_ALIAS` 表示 rowid */
  orderBy?: string
  /** 是否降序 */
  desc?: boolean
}

/**
 * 拼 WHERE 子句
 * @param where 条件
 * @returns 以空格开头的子句；无条件时为空串
 */
function whereOf(where: string | undefined): string {
  const text = (where ?? "").trim().replace(/;+$/, "").trim()
  return text === "" ? "" : ` WHERE (${text})`
}

/**
 * 浏览一页表数据的语句；带 rowid 的表多取一列 rowid，用于定位改删
 * @param table 表
 * @param q 筛选与排序
 * @returns SQL，参数依次为 LIMIT 与 OFFSET
 */
export function browseSqlOf(table: SqlTable, q: BrowseQuery = {}): string {
  const cols = table.rowid ? `rowid AS ${quoteIdent(ROWID_ALIAS)}, *` : "*"
  const order =
    q.orderBy === undefined || q.orderBy === ""
      ? ""
      : ` ORDER BY ${q.orderBy === ROWID_ALIAS ? "rowid" : quoteIdent(q.orderBy)} ${q.desc === true ? "DESC" : "ASC"}`
  return `SELECT ${cols} FROM ${quoteIdent(table.name)}${whereOf(q.where)}${order} LIMIT ? OFFSET ?`
}

/**
 * 统计行数的语句
 * @param table 表
 * @param where 筛选条件
 * @returns SQL，无参数
 */
export function countSqlOf(table: SqlTable, where?: string): string {
  return `SELECT count(*) FROM ${quoteIdent(table.name)}${whereOf(where)}`
}

/**
 * 一次统计多张表行数的语句
 * @param tables 表名，不可为空
 * @returns SQL，无参数；结果为一行，第 i 列是第 i 张表的行数
 */
export function countAllSqlOf(tables: readonly string[]): string {
  return `SELECT ${tables.map((t, i) => `(SELECT count(*) FROM ${quoteIdent(t)}) AS c${i}`).join(", ")}`
}

/**
 * 按 rowid 更新若干列的语句
 * @param table 表名
 * @param columns 要更新的列，不可为空
 * @returns SQL，参数依次为各列新值与 rowid
 */
export function updateRowSqlOf(table: string, columns: readonly string[]): string {
  const sets = columns.map(c => `${quoteIdent(c)} = ?`).join(", ")
  return `UPDATE ${quoteIdent(table)} SET ${sets} WHERE rowid = ?`
}

/**
 * 插入一行的语句
 * @param table 表名
 * @param columns 显式赋值的列；为空时全部取默认值
 * @returns SQL，参数依次为各列的值
 */
export function insertSqlOf(table: string, columns: readonly string[]): string {
  if (columns.length === 0) return `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`
  return `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
}

/**
 * 按 rowid 删除一行的语句
 * @param table 表名
 * @returns SQL，参数为 rowid
 */
export function deleteSqlOf(table: string): string {
  return `DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`
}

/** 列出一张表的索引，参数为表名 */
export const INDEX_SQL = "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name"

/** 取一张表或视图的建表语句，参数为名字 */
export const DDL_SQL = "SELECT sql FROM sqlite_master WHERE name = ?"

/** 语句高亮的一段 */
export interface SqlToken {
  /** 原文 */
  text: string
  /** 类别：关键字、字符串、数字、带引号的标识符、注释，其余为 plain */
  kind: "kw" | "str" | "num" | "ident" | "comment" | "plain"
}

/** 高亮时认作关键字的词 */
const SQL_KEYWORDS = new Set(
  (
    "SELECT FROM WHERE AND OR NOT NULL CREATE TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES ON " +
    "DELETE UPDATE INSERT INTO VALUES SET DEFAULT CHECK CONSTRAINT AUTOINCREMENT INTEGER TEXT REAL BLOB " +
    "NUMERIC IF EXISTS AS WITHOUT ROWID CASCADE COLLATE ORDER BY GROUP LIMIT OFFSET JOIN LEFT INNER IS IN " +
    "LIKE BETWEEN DESC ASC TRIGGER BEGIN END STRICT GENERATED ALWAYS STORED VIRTUAL USING"
  ).split(" ")
)

/** 依次匹配注释、字符串、带引号的标识符、数字、单词 */
const SQL_TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * 把语句切成供高亮的片段
 * @param sql SQL 文本
 * @returns 片段，拼接后与原文一致
 */
export function sqlTokens(sql: string): SqlToken[] {
  const out: SqlToken[] = []
  let last = 0
  for (const m of sql.matchAll(SQL_TOKEN)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: sql.slice(last, at), kind: "plain" })
    const kind: SqlToken["kind"] =
      m[1] !== undefined
        ? "comment"
        : m[2] !== undefined
          ? "str"
          : m[3] !== undefined
            ? "ident"
            : m[4] !== undefined
              ? "num"
              : SQL_KEYWORDS.has(m[0].toUpperCase())
                ? "kw"
                : "plain"
    out.push({ text: m[0], kind })
    last = at + m[0].length
  }
  if (last < sql.length) out.push({ text: sql.slice(last), kind: "plain" })
  return out
}

/** 会删改数据或结构的语句开头 */
const DESTRUCTIVE = /^(drop|delete|update|alter|replace)\b/i

/**
 * 语句是否以删改类关键字开头
 *
 * 只用于执行前的二次确认，判定写不写库仍由内核按 `stmt.readonly` 决定。
 * @param sql SQL 文本
 * @returns 是否需要二次确认
 */
export function isDestructiveSql(sql: string): boolean {
  let rest = sql
  for (;;) {
    rest = rest.trimStart()
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n")
      rest = end < 0 ? "" : rest.slice(end + 1)
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/")
      rest = end < 0 ? "" : rest.slice(end + 2)
    } else break
  }
  return DESTRUCTIVE.test(rest)
}

/** 一条语句模板 */
export interface SqlTemplate {
  /** 菜单文案 */
  label: string
  /** 语句 */
  sql: string
}

/**
 * 控制台的语句模板
 * @param table 当前选中的表；未选时以占位名代替
 * @returns 模板
 */
export function sqlTemplatesOf(table: string | undefined): SqlTemplate[] {
  const name = table ?? "表名"
  const t = quoteIdent(name)
  return [
    { label: "查看前 50 行", sql: `SELECT * FROM ${t} LIMIT 50` },
    { label: "统计行数", sql: `SELECT count(*) AS n FROM ${t}` },
    { label: "列信息", sql: `SELECT * FROM pragma_table_info('${name.replaceAll("'", "''")}')` },
    { label: "全部表与视图", sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name" },
    { label: "库文件大小", sql: "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()" }
  ]
}

/**
 * 记入一条执行历史：去重并置顶
 * @param list 现有历史，新的在前
 * @param sql 刚执行的语句
 * @param max 保留条数
 * @returns 新的历史
 */
export function pushHistory(list: readonly string[], sql: string, max = 30): string[] {
  const text = sql.trim()
  if (text === "") return [...list]
  return [text, ...list.filter(s => s !== text)].slice(0, max)
}

/* ────────────────────────────── 单元格与导出 ────────────────────────────── */

/**
 * 是否为二进制单元格
 * @param cell 单元格
 * @returns 是否为 `{ $blob, head }`
 */
export function isBlobCell(cell: unknown): cell is { $blob: number; head: string } {
  return typeof cell === "object" && cell !== null && "$blob" in cell
}

/**
 * 单元格的显示文本
 * @param cell 单元格
 * @returns 文本；NULL 显示为 `NULL`
 */
export function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "NULL"
  if (isBlobCell(cell)) return `<BLOB ${cell.$blob} 字节>`
  if (typeof cell === "object") return JSON.stringify(cell)
  return String(cell)
}

/**
 * 单元格在编辑框中的初始文本
 * @param cell 单元格
 * @returns 文本；NULL 为空串
 */
export function cellEditText(cell: unknown): string {
  return cell === null || cell === undefined ? "" : cellText(cell)
}

/**
 * 将编辑框中的文本转为绑定参数
 *
 * 列声明为数值亲和（INT / REAL / NUM / FLOA / DOUB / DEC）且输入为数字时按数字绑定，其余一律按文本绑定。
 * @param text 文本
 * @param column 列
 * @param isNull 是否置为 NULL
 * @returns 绑定参数
 */
export function cellParamOf(text: string, column: SqlColumn | undefined, isNull: boolean): string | number | null {
  if (isNull) return null
  const numeric = /INT|REAL|NUM|FLOA|DOUB|DEC/i.test(column?.type ?? "")
  const trimmed = text.trim()
  if (numeric && trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed)
  return text
}

/**
 * 结果列的显示名
 * @param column 列名
 * @returns rowid 别名显示为 `rowid`
 */
export function columnLabel(column: string): string {
  return column === ROWID_ALIAS ? "rowid" : column
}

/**
 * CSV 单元格
 * @param cell 单元格
 * @returns 已按需加引号的文本；NULL 为空
 */
function csvCell(cell: unknown): string {
  const text = cellEditText(cell)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * 结果转 CSV
 * @param columns 列名
 * @param rows 行
 * @returns CSV 文本，行以 CRLF 分隔
 */
export function toCsv(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [columns.map(columnLabel), ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")
}

/**
 * 结果转对象数组
 * @param columns 列名
 * @param rows 行
 * @returns 每行一个对象
 */
export function rowsAsObjects(columns: readonly string[], rows: readonly (readonly unknown[])[]): Record<string, unknown>[] {
  return rows.map(row => Object.fromEntries(columns.map((c, i) => [columnLabel(c), row[i] ?? null])))
}
