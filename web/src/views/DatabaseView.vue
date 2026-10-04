<script setup lang="ts">
/**
 * 模块职责：数据库页 —— 概览存储用量；浏览与编辑 KV；浏览、改删 SQLite 并执行单条语句
 * 依赖方向：依赖 api / confirm / download / format / icons / storage / types 与 components 下的若干组件
 * 生命周期：挂载时读概览；首次切到 KV 或 SQLite 页签时各自取数；成功提示 NOTICE_MS 后自动收起
 * 注意事项：只读模式下写按钮隐去，门在内核（KV 写路由各判一次，SQL 按 `stmt.readonly` 判）。
 *
 *          键为驱动层完整键；修改 `plugin:<名>:` 下的键即直接修改该插件的数据，插件不会收到通知。
 *
 *          删键、清前缀与删行一律经确认；清前缀与批量删除还须键入指定文字 —— 这两件事一次影响多条记录。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { del, get, post, put } from "../api.js"
import { askConfirm } from "../confirm.js"
import { copyText, downloadText, fileNameOf } from "../download.js"
import { bytes, datetime, errorText } from "../format.js"
import { ICONS } from "../icons.js"
import {
  DDL_SQL,
  INDEX_SQL,
  KV_TYPE_LABEL,
  ROWID_ALIAS,
  TTL_PRESETS,
  browseSqlOf,
  cellEditText,
  cellParamOf,
  cellText,
  columnLabel,
  countAllSqlOf,
  countSqlOf,
  crumbsOf,
  deleteSqlOf,
  diffLines,
  diffStat,
  foldDiff,
  insertSqlOf,
  isBlobCell,
  isDestructiveSql,
  isSensitive,
  jsonBytes,
  kvTypeOf,
  parentOf,
  parseValueText,
  pushHistory,
  reformatJson,
  resolveExpireAt,
  rowsAsObjects,
  sharesOf,
  sortKvItems,
  sqlTemplatesOf,
  sqlTokens,
  toCsv,
  ttlText,
  updateRowSqlOf,
  valueTextOf,
  type KvSort,
  type TtlChoice,
  type ValueMode
} from "../storage.js"
import AppIcon from "../components/AppIcon.vue"
import CountUp from "../components/CountUp.vue"
import DangerConfirm from "../components/DangerConfirm.vue"
import DonutChart from "../components/DonutChart.vue"
import EmptyState from "../components/EmptyState.vue"
import JsonTree from "../components/JsonTree.vue"
import Modal from "../components/Modal.vue"
import PageHeader from "../components/PageHeader.vue"
import type { KvEntry, KvGroup, KvItem, KvPage, SqlOverview, SqlResult, SqlTable, KvValueType } from "../types.js"

/** 三个页签，概览居首 */
const TABS = [
  { id: "home", label: "概览", icon: ICONS.gauge },
  { id: "kv", label: "KV", icon: ICONS.key },
  { id: "sql", label: "SQLite", icon: ICONS.database }
] as const

/** 值大类的角标 */
const TYPE_GLYPH: Record<KvValueType, string> = {
  object: "{ }",
  array: "[ ]",
  string: "“ ”",
  number: "#",
  boolean: "01",
  null: "∅"
}

/** 成功提示停留的毫秒数 */
const NOTICE_MS = 2600

/** KV 每页键数 */
const KV_PAGE = 100

/** 浏览表时每页行数 */
const SQL_PAGE = 100

/** 控制台返回的行数上限 */
const QUERY_LIMIT = 500

/** 执行历史在 localStorage 中的键 */
const HISTORY_KEY = "yunzai-ng.sql-history"

const tab = ref<(typeof TABS)[number]["id"]>("home")
const error = ref("")
const notice = ref("")
const busy = ref(false)
/** 计算剩余存活时间的基准时刻，每次读取时刷新 */
const now = ref(Date.now())

let noticeTimer: ReturnType<typeof setTimeout> | undefined
// 成功提示只是回执，浮出片刻即收起，不占版面
watch(notice, text => {
  clearTimeout(noticeTimer)
  if (text !== "") noticeTimer = setTimeout(() => (notice.value = ""), NOTICE_MS)
})
onBeforeUnmount(() => clearTimeout(noticeTimer))

/* ────────────────────────────── 概览 ────────────────────────────── */

/** 根前缀那一页，只取统计用的字段 */
const root = ref<KvPage | undefined>(undefined)
/** `plugin:` 之下的各插件命名空间 */
const pluginGroups = ref<KvGroup[]>([])

/** 概览里的一个库 */
interface DbStat {
  /** 形如 `插件/库名` */
  key: string
  /** 文件字节数 */
  size: number
  /** 当前是否已有连接 */
  open: boolean
  /** 表与视图数 */
  tables: number
  /** 各表行数之和；统计失败时 undefined */
  rows: number | undefined
}

const dbStats = ref<DbStat[]>([])

/** 根前缀下的键总数，含各级子命名空间 */
const kvTotal = computed(() => (root.value?.total ?? 0) + (root.value?.groups.reduce((n, g) => n + g.count, 0) ?? 0))
/** 顶层命名空间的键数占比 */
const topShares = computed(() => sharesOf(root.value?.groups ?? [], root.value?.total ?? 0))
/** 各插件命名空间的键数占比 */
const pluginShares = computed(() => sharesOf(pluginGroups.value))
/** 全部库的文件大小之和 */
const dbBytes = computed(() => dbStats.value.reduce((n, d) => n + d.size, 0))
const dbRows = computed(() => dbStats.value.reduce((n, d) => n + (d.rows ?? 0), 0))
const dbTables = computed(() => dbStats.value.reduce((n, d) => n + d.tables, 0))
/** 环形图的数据，key 即点击后进入的前缀 */
const topDonut = computed(() => topShares.value.map(s => ({ key: s.name, label: s.name || "（根直属）", value: s.count })))
const pluginDonut = computed(() =>
  pluginShares.value.map(s => ({ key: `plugin:${s.name}`, label: s.name.replace(/:$/, ""), value: s.count }))
)
const pluginTotal = computed(() => pluginShares.value.reduce((n, s) => n + s.count, 0))

/* ────────────────────────────── KV ────────────────────────────── */

const page = ref<KvPage | undefined>(undefined)
const prefix = ref("")
/** 前缀直达输入框 */
const jump = ref("")
/** 已翻过的各页起点，首页为 undefined */
const cursors = ref<(string | undefined)[]>([undefined])
/** 敏感键的内容是否显示 */
const revealed = ref(false)
/** 按键名筛选 */
const kvFilter = ref("")
/** 按值的大类筛选；空串为不限 */
const kvType = ref<"" | KvValueType>("")
const kvSort = ref<KvSort>("name")
const kvDesc = ref(false)
/** 勾选的键 */
const picked = ref(new Set<string>())

const crumbs = computed(() => crumbsOf(prefix.value))
const sensitiveHere = computed(() => page.value?.items.some(item => isSensitive(item.key)) === true)
/** 当前前缀之下的键总数，含子命名空间 */
const countHere = computed(() => (page.value?.total ?? 0) + (page.value?.groups.reduce((n, g) => n + g.count, 0) ?? 0))
/** 子命名空间中最大的键数，侧栏比例条以它为满格 */
const groupMax = computed(() => Math.max(1, ...(page.value?.groups ?? []).map(g => g.count)))

/** 经筛选与排序后的本页键 */
const shown = computed<KvItem[]>(() => {
  const all = page.value?.items ?? []
  const text = kvFilter.value.trim().toLowerCase()
  const type = kvType.value
  const kept = all.filter(
    item => (text === "" || item.key.toLowerCase().includes(text)) && (type === "" || item.type === type)
  )
  return sortKvItems(kept, kvSort.value, kvDesc.value)
})

/** 本页出现过的值的大类，供筛选下拉 */
const typesHere = computed(() => [...new Set((page.value?.items ?? []).map(item => item.type))])

const allPicked = computed(() => shown.value.length > 0 && shown.value.every(item => picked.value.has(item.key)))

/* ────────────────────────────── SQLite ────────────────────────────── */

const sql = ref<SqlOverview | undefined>(undefined)
/** 选中的库，形如 `插件/库名` */
const db = ref("")
const tables = ref<SqlTable[]>([])
/** 正在浏览的表；结果来自控制台时为 undefined，此时行不可改 */
const browsing = ref<SqlTable | undefined>(undefined)
/** 表的三种视图 */
const tableView = ref<"data" | "struct" | "ddl">("data")
const offset = ref(0)
const result = ref<SqlResult | undefined>(undefined)
/** 当前筛选条件下的行数；统计失败时 undefined */
const rowTotal = ref<number | undefined>(undefined)
/** WHERE 子句，由使用者填写 */
const where = ref("")
/** 排序列；空串为不排序 */
const orderBy = ref("")
const orderDesc = ref(false)
/** 结构视图里的索引 */
const indexes = ref<{ name: string; sql: string }[]>([])
/** DDL 视图里的建表语句 */
const ddl = ref("")
const ddlTokens = computed(() => sqlTokens(ddl.value))

const query = ref("")
const history = ref<string[]>(readHistory())
const showHistory = ref(false)

const readonly = computed(() => page.value?.readonly === true || sql.value?.readonly === true || root.value?.readonly === true)

/** 结果能否按 rowid 改删 */
const editable = computed(
  () => !readonly.value && browsing.value?.rowid === true && result.value?.columns?.[0] === ROWID_ALIAS
)

const templates = computed(() => sqlTemplatesOf(browsing.value?.name))

/* ────────────────────────────── 取数 ────────────────────────────── */

/**
 * 把 `插件/库名` 拼成路径段
 * @param key 库键
 * @returns 已转义的路径
 */
function dbPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/")
}

/**
 * 在指定库上执行一条语句
 * @param key 库键
 * @param text SQL
 * @param params 绑定参数
 * @param limit 行数上限
 * @returns 执行结果
 */
function execOn(key: string, text: string, params: (string | number | null)[], limit: number): Promise<SqlResult> {
  return post<SqlResult>(`storage/sql/${dbPath(key)}/query`, { sql: text, params, limit })
}

/**
 * 在当前库上执行一条语句
 * @param text SQL
 * @param params 绑定参数
 * @param limit 行数上限
 * @returns 执行结果
 */
function run(text: string, params: (string | number | null)[], limit: number): Promise<SqlResult> {
  return execOn(db.value, text, params, limit)
}

/** 读概览：KV 的命名空间分布与各库的表数、行数 */
async function loadHome(): Promise<void> {
  busy.value = true
  try {
    root.value = await get<KvPage>("storage/kv?prefix=&limit=1")
    const hasPlugins = root.value.groups.some(g => g.name === "plugin:")
    pluginGroups.value = hasPlugins ? (await get<KvPage>("storage/kv?prefix=plugin%3A&limit=1")).groups : []

    const overview = await get<SqlOverview>("storage/sql")
    sql.value = overview
    const stats: DbStat[] = []
    for (const item of overview.databases) {
      const key = `${item.plugin}/${item.name}`
      const stat: DbStat = { key, size: item.size, open: item.open, tables: 0, rows: undefined }
      try {
        const list = (await get<{ tables: SqlTable[] }>(`storage/sql/${dbPath(key)}/tables`)).tables
        stat.tables = list.length
        const names = list.filter(t => t.type === "table").map(t => t.name)
        if (names.length === 0) stat.rows = 0
        else {
          const counted = await execOn(key, countAllSqlOf(names), [], 1)
          stat.rows = (counted.rows?.[0] ?? []).reduce<number>((n, cell) => n + Number(cell ?? 0), 0)
        }
      } catch {
        // 单个库读不动不该让整页空着，其余库照常统计
      }
      stats.push(stat)
    }
    dbStats.value = stats
    now.value = Date.now()
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 读一页 KV
 * @param next 前缀
 * @param after 分页游标
 */
async function loadKv(next = prefix.value, after?: string): Promise<void> {
  busy.value = true
  try {
    const q = new URLSearchParams({ prefix: next, limit: String(KV_PAGE) })
    if (after !== undefined) q.set("after", after)
    page.value = await get<KvPage>(`storage/kv?${q.toString()}`)
    prefix.value = next
    jump.value = next
    now.value = Date.now()
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 进入一个前缀，从首页读起
 * @param next 前缀
 */
function enter(next: string): void {
  cursors.value = [undefined]
  revealed.value = false
  picked.value = new Set()
  kvFilter.value = ""
  kvType.value = ""
  void loadKv(next)
}

/** 下一页 */
function nextPage(): void {
  const cursor = page.value?.next
  if (cursor === undefined) return
  cursors.value.push(cursor)
  void loadKv(prefix.value, cursor)
}

/** 上一页 */
function prevPage(): void {
  if (cursors.value.length <= 1) return
  cursors.value.pop()
  void loadKv(prefix.value, cursors.value[cursors.value.length - 1])
}

/** 原地重读当前页 */
function reloadKv(): Promise<void> {
  return loadKv(prefix.value, cursors.value[cursors.value.length - 1])
}

/**
 * 从概览跳到 KV 的某个前缀
 * @param target 前缀
 */
function gotoKv(target: string): void {
  tab.value = "kv"
  notice.value = ""
  enter(target)
}

/**
 * 从概览跳到某个库
 * @param key 库键
 */
function gotoSql(key: string): void {
  tab.value = "sql"
  notice.value = ""
  void pickDb(key)
}

/**
 * 切页签；首次进入时各自取数
 * @param id 页签
 */
function switchTab(id: (typeof TABS)[number]["id"]): void {
  tab.value = id
  notice.value = ""
  if (id === "kv" && page.value === undefined) void loadKv("")
  if (id === "sql" && sql.value === undefined) void loadSql()
}

/** 页头的刷新 */
async function refresh(): Promise<void> {
  if (tab.value === "home") return loadHome()
  if (tab.value === "kv") return reloadKv()
  await loadSql()
  if (db.value !== "") await pickDb(db.value)
}

/* ────────────────────────────── 键的查看与编辑 ────────────────────────────── */

const editing = ref(false)
const isNew = ref(false)
const editKey = ref("")
const editMode = ref<ValueMode>("json")
const editText = ref("")
/** 打开时的文本，用于差异 */
const editOrigin = ref("")
const editExpireAt = ref<number | undefined>(undefined)
const ttlChoice = ref<TtlChoice>("keep")
/** 自定义过期的秒数 */
const ttlCustom = ref("")
const editError = ref("")
/** 敏感键的内容是否先隐去 */
const editHidden = ref(false)
/** 抽屉里的三种视图 */
const editView = ref<"tree" | "edit" | "diff">("tree")

/** 文本当前是否可解析，以及解析出的值 */
const parsed = computed(() => parseValueText(editText.value, editMode.value))
/** 树形视图要展示的值 */
const treeValue = computed(() => (parsed.value.ok ? parsed.value.value : undefined))
const changed = computed(() => editText.value !== editOrigin.value)
/** 折叠后的差异 */
const diff = computed(() => foldDiff(diffLines(editOrigin.value, editText.value)))
const diffCount = computed(() => diffStat(diffLines(editOrigin.value, editText.value)))
/** 值序列化后的字节数 */
const editBytes = computed(() => (parsed.value.ok ? jsonBytes(parsed.value.value) : 0))
const lineCount = computed(() => editText.value.split("\n").length)

/** 有效期一栏下方的说明 */
const ttlNote = computed(() => {
  if (ttlChoice.value === "never") return "写入后永不过期"
  if (ttlChoice.value !== "keep") return "按所选时长从写入时刻重新计时"
  return editExpireAt.value === undefined ? "当前永不过期" : `当前 ${datetime(editExpireAt.value)} 过期`
})

/**
 * 打开一个已有的键
 * @param key 完整键
 */
async function openEntry(key: string): Promise<void> {
  try {
    const entry = await get<KvEntry>(`storage/kv/entry?key=${encodeURIComponent(key)}`)
    const { mode, text } = valueTextOf(entry.value)
    isNew.value = false
    editKey.value = key
    editMode.value = mode
    editText.value = text
    editOrigin.value = text
    editExpireAt.value = entry.expireAt
    ttlChoice.value = "keep"
    ttlCustom.value = ""
    editError.value = ""
    editHidden.value = isSensitive(key) && !revealed.value
    editView.value = "tree"
    now.value = Date.now()
    editing.value = true
  } catch (err) {
    error.value = errorText(err)
  }
}

/** 新建一个键，键名预填当前前缀 */
function openNew(): void {
  isNew.value = true
  editKey.value = prefix.value
  editMode.value = "json"
  editText.value = ""
  editOrigin.value = ""
  editExpireAt.value = undefined
  ttlChoice.value = "never"
  ttlCustom.value = ""
  editError.value = ""
  editHidden.value = false
  editView.value = "edit"
  editing.value = true
}

/**
 * 重排 JSON
 * @param pretty 为真时缩进两格，否则压缩为一行
 */
function format(pretty: boolean): void {
  const done = reformatJson(editText.value, pretty)
  if (!done.ok) {
    editError.value = done.error
    return
  }
  editText.value = done.text
  editError.value = ""
}

/** 保存抽屉里的键 */
async function saveEntry(): Promise<void> {
  const key = editKey.value.trim()
  if (key === "") {
    editError.value = "键不能为空"
    return
  }
  const value = parseValueText(editText.value, editMode.value)
  if (!value.ok) {
    editError.value = value.error
    return
  }
  const at = resolveExpireAt(ttlChoice.value, ttlCustom.value, editExpireAt.value, Date.now())
  if (!at.ok) {
    editError.value = at.error
    return
  }

  if (isNew.value && !(await confirmOverwrite(key))) return

  busy.value = true
  try {
    await put("storage/kv/entry", { key, value: value.value, ...(at.expireAt === undefined ? {} : { expireAt: at.expireAt }) })
    editing.value = false
    notice.value = `已保存 ${key}`
    await reloadKv()
  } catch (err) {
    editError.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 键已存在时征询是否覆盖
 * @param key 完整键
 * @returns 是否继续写入
 */
async function confirmOverwrite(key: string): Promise<boolean> {
  const exists = await get(`storage/kv/entry?key=${encodeURIComponent(key)}`).then(
    () => true,
    () => false
  )
  if (!exists) return true
  return askConfirm({
    title: `键 ${key} 已存在，覆盖？`,
    body: "原值将被替换，此操作无法撤销。",
    okText: "覆盖",
    danger: true
  })
}

/**
 * 删一个键
 * @param key 完整键
 */
async function removeEntry(key: string): Promise<void> {
  const ok = await askConfirm({
    title: `删除键 ${key}？`,
    body: "该键及其值将被移除，此操作无法撤销。",
    okText: "删除",
    danger: true
  })
  if (!ok) return
  try {
    await del(`storage/kv/entry?key=${encodeURIComponent(key)}`)
    editing.value = false
    notice.value = `已删除 ${key}`
    await reloadKv()
  } catch (err) {
    error.value = errorText(err)
  }
}

/* ───── 另存与改名 ───── */

const copyTo = ref(false)
/** 另存或改名的目标键 */
const copyKey = ref("")
/** 为真时写入后删除原键 */
const copyMove = ref(false)

/**
 * 打开另存框
 * @param move 为真时写入新键后删除原键
 */
function openCopy(move: boolean): void {
  copyMove.value = move
  copyKey.value = editKey.value
  copyTo.value = true
}

/** 另存或改名 */
async function saveCopy(): Promise<void> {
  const target = copyKey.value.trim()
  const from = editKey.value
  if (target === "" || target === from) {
    editError.value = "请填写一个不同的键"
    return
  }
  const value = parseValueText(editText.value, editMode.value)
  if (!value.ok) {
    editError.value = value.error
    return
  }
  if (!(await confirmOverwrite(target))) return

  busy.value = true
  try {
    await put("storage/kv/entry", {
      key: target,
      value: value.value,
      ...(editExpireAt.value === undefined ? {} : { expireAt: editExpireAt.value })
    })
    if (copyMove.value) await del(`storage/kv/entry?key=${encodeURIComponent(from)}`)
    copyTo.value = false
    editing.value = false
    notice.value = copyMove.value ? `已改名为 ${target}` : `已另存为 ${target}`
    await reloadKv()
  } catch (err) {
    editError.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/* ───── 复制与导出 ───── */

/**
 * 复制一段文本并提示结果
 * @param text 文本
 * @param what 提示里对这段文本的称呼
 */
async function copy(text: string, what: string): Promise<void> {
  try {
    await copyText(text)
    notice.value = `已复制${what}`
  } catch (err) {
    error.value = errorText(err)
  }
}

/** 把当前键的值存成文件 */
function downloadEntry(): void {
  downloadText(`${fileNameOf(editKey.value)}.json`, editText.value, editMode.value === "json" ? "application/json" : "text/plain")
}

/* ────────────────────────────── 危险操作 ────────────────────────────── */

/** 一次须键入确认文字的操作 */
interface DangerAsk {
  /** 标题 */
  title: string
  /** 说明影响范围 */
  body: string
  /** 须键入的文字 */
  expected: string
  /** 额外警示 */
  warning?: string
  /** 受影响的样例 */
  samples?: string[]
  /** 确认按钮文案 */
  okText?: string
  /** 确认后执行 */
  run: () => Promise<void>
}

const danger = ref<DangerAsk | undefined>(undefined)

/** 执行已确认的危险操作 */
async function runDanger(): Promise<void> {
  const ask = danger.value
  if (ask === undefined) return
  busy.value = true
  try {
    await ask.run()
    danger.value = undefined
  } catch (err) {
    error.value = errorText(err)
    danger.value = undefined
  } finally {
    busy.value = false
  }
}

/**
 * 清空一个前缀：删除其下全部键
 * @param target 前缀
 */
function askClearPrefix(target: string): void {
  const sample = (page.value?.items ?? []).slice(0, 5).map(item => item.key)
  danger.value = {
    title: "删除此前缀下的全部键",
    body: `将删除以 ${target} 开头的全部键，约 ${countHere.value} 个，含各级子命名空间。数据立即从存储中移除，无法撤销。`,
    expected: target,
    warning: target.startsWith("plugin:")
      ? "这是插件的命名空间，删除后该插件保存的数据全部丢失，且插件不会收到通知。"
      : undefined,
    samples: sample,
    okText: "删除全部",
    run: async () => {
      const done = await post<{ removed: number }>("storage/kv/clear", { prefix: target })
      notice.value = `已删除 ${target} 之下的 ${done.removed} 个键`
      enter(prefix.value)
    }
  }
}

/** 删除勾选的键 */
function askRemovePicked(): void {
  const keys = [...picked.value]
  if (keys.length === 0) return
  danger.value = {
    title: `删除勾选的 ${keys.length} 个键`,
    body: "这些键及其值将被移除，此操作无法撤销。",
    expected: "删除",
    samples: keys.slice(0, 5),
    okText: "删除",
    run: async () => {
      let removed = 0
      for (const key of keys) {
        await del(`storage/kv/entry?key=${encodeURIComponent(key)}`)
        removed++
      }
      picked.value = new Set()
      notice.value = `已删除 ${removed} 个键`
      await reloadKv()
    }
  }
}

/**
 * 勾选或取消一个键
 * @param key 完整键
 */
function togglePick(key: string): void {
  if (picked.value.has(key)) picked.value.delete(key)
  else picked.value.add(key)
}

/** 全选或全不选本页（已筛选）的键 */
function toggleAll(): void {
  if (allPicked.value) picked.value = new Set()
  else picked.value = new Set(shown.value.map(item => item.key))
}

/* ────────────────────────────── SQLite ────────────────────────────── */

/** 读库清单 */
async function loadSql(): Promise<void> {
  try {
    sql.value = await get<SqlOverview>("storage/sql")
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  }
}

/** 重读当前库的表清单 */
async function loadTables(): Promise<void> {
  tables.value = (await get<{ tables: SqlTable[] }>(`storage/sql/${dbPath(db.value)}/tables`)).tables
}

/**
 * 选一个库并读它的表
 * @param key 库键
 */
async function pickDb(key: string): Promise<void> {
  db.value = key
  browsing.value = undefined
  result.value = undefined
  rowTotal.value = undefined
  try {
    await loadTables()
    error.value = ""
  } catch (err) {
    tables.value = []
    error.value = errorText(err)
  }
}

/**
 * 浏览一张表
 * @param table 表
 * @param at 起始行
 */
async function browse(table: SqlTable, at = 0): Promise<void> {
  busy.value = true
  try {
    result.value = await run(
      browseSqlOf(table, { where: where.value, orderBy: orderBy.value, desc: orderDesc.value }),
      [SQL_PAGE, at],
      SQL_PAGE
    )
    browsing.value = table
    offset.value = at
    error.value = ""
    try {
      const counted = await run(countSqlOf(table, where.value), [], 1)
      rowTotal.value = Number(counted.rows?.[0]?.[0] ?? 0)
    } catch {
      // 视图上的 count 可能很慢或失败，缺了它仍可翻页
      rowTotal.value = undefined
    }
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 选一张表，默认看数据
 * @param table 表
 */
function pickTable(table: SqlTable): void {
  tableView.value = "data"
  where.value = ""
  orderBy.value = ""
  orderDesc.value = false
  void browse(table, 0)
}

/**
 * 按某列排序；重复点同一列切换升降
 * @param column 结果列名
 */
function sortBy(column: string): void {
  const table = browsing.value
  if (table === undefined) return
  if (orderBy.value === column) orderDesc.value = !orderDesc.value
  else {
    orderBy.value = column
    orderDesc.value = false
  }
  void browse(table, 0)
}

/** 切回数据视图 */
function showData(): void {
  const table = browsing.value
  if (table === undefined) return
  tableView.value = "data"
  void browse(table, offset.value)
}

/** 清除筛选条件并从首行读起 */
function clearWhere(): void {
  where.value = ""
  if (browsing.value !== undefined) void browse(browsing.value, 0)
}

/** 读结构视图要用的索引 */
async function loadStruct(): Promise<void> {
  const table = browsing.value
  if (table === undefined) return
  tableView.value = "struct"
  try {
    const got = await run(INDEX_SQL, [table.name], 100)
    indexes.value = (got.rows ?? []).map(row => ({ name: String(row[0] ?? ""), sql: String(row[1] ?? "") }))
    error.value = ""
  } catch (err) {
    indexes.value = []
    error.value = errorText(err)
  }
}

/** 读 DDL 视图要用的建表语句 */
async function loadDdl(): Promise<void> {
  const table = browsing.value
  if (table === undefined) return
  tableView.value = "ddl"
  try {
    const got = await run(DDL_SQL, [table.name], 1)
    ddl.value = String(got.rows?.[0]?.[0] ?? "")
    error.value = ""
  } catch (err) {
    ddl.value = ""
    error.value = errorText(err)
  }
}

/* ───── 整行编辑 ───── */

/** 编辑框里的一个单元格 */
interface CellDraft {
  /** 列名 */
  name: string
  /** 文本 */
  text: string
  /** 是否置为 NULL */
  isNull: boolean
  /** 是否为二进制，二进制不可改 */
  blob: boolean
}

const rowDraft = ref<{ rowid: string | number | undefined; cells: CellDraft[] } | undefined>(undefined)

/**
 * 打开一行的编辑框
 * @param index 行下标
 */
function openRow(index: number): void {
  const table = browsing.value
  const row = result.value?.rows?.[index]
  const columns = result.value?.columns
  if (table === undefined || row === undefined || columns === undefined) return
  const cells: CellDraft[] = []
  columns.forEach((name, i) => {
    if (name === ROWID_ALIAS) return
    const cell = row[i]
    cells.push({ name, text: cellEditText(cell), isNull: cell === null, blob: isBlobCell(cell) })
  })
  rowDraft.value = { rowid: row[0] as string | number, cells }
}

/** 打开插入新行的编辑框 */
function openInsert(): void {
  const table = browsing.value
  if (table === undefined) return
  rowDraft.value = {
    rowid: undefined,
    cells: table.columns.map(c => ({ name: c.name, text: "", isNull: !c.notnull && c.pk === 0, blob: false }))
  }
}

/** 保存整行 */
async function saveRow(): Promise<void> {
  const draft = rowDraft.value
  const table = browsing.value
  if (draft === undefined || table === undefined) return
  const cells = draft.cells.filter(c => !c.blob)
  const params = cells.map(c => cellParamOf(c.text, table.columns.find(d => d.name === c.name), c.isNull))
  busy.value = true
  try {
    if (draft.rowid === undefined) {
      await run(insertSqlOf(table.name, cells.map(c => c.name)), params, 1)
      notice.value = "已插入 1 行"
    } else {
      await run(updateRowSqlOf(table.name, cells.map(c => c.name)), [...params, draft.rowid], 1)
      notice.value = "已更新 1 行"
    }
    rowDraft.value = undefined
    await browse(table, offset.value)
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 删一行
 * @param index 行下标
 */
async function removeRow(index: number): Promise<void> {
  const table = browsing.value
  const rowid = result.value?.rows?.[index]?.[0] as string | number | undefined
  if (table === undefined || rowid === undefined) return
  const ok = await askConfirm({
    title: `删除 ${table.name} 中 rowid 为 ${rowid} 的行？`,
    body: "该行将从表中移除，此操作无法撤销。若外键设有级联删除，关联行会一并删除。",
    okText: "删除",
    danger: true
  })
  if (!ok) return
  try {
    await run(deleteSqlOf(table.name), [rowid], 1)
    notice.value = "已删除 1 行"
    await browse(table, offset.value)
  } catch (err) {
    error.value = errorText(err)
  }
}

/* ───── 控制台 ───── */

/**
 * 读执行历史
 * @returns 历史语句，新的在前
 */
function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsedRaw: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsedRaw) ? parsedRaw.filter((s): s is string => typeof s === "string") : []
  } catch {
    // 浏览器不允许读写本地存储时不留历史即可
    return []
  }
}

/** 写回执行历史 */
function writeHistory(): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
  } catch {
    // 同上
  }
}

/** 执行控制台里的语句 */
async function runQuery(): Promise<void> {
  const text = query.value.trim()
  if (text === "") return
  if (
    isDestructiveSql(text) &&
    !(await askConfirm({
      title: "执行这条语句？",
      body: "该语句会改动表中的数据或结构，执行后无法撤销。",
      okText: "执行",
      danger: true,
      details: [text.slice(0, 200)]
    }))
  ) {
    return
  }

  busy.value = true
  try {
    const done = await run(text, [], QUERY_LIMIT)
    result.value = done
    browsing.value = undefined
    rowTotal.value = undefined
    history.value = pushHistory(history.value, text)
    writeHistory()
    error.value = ""
    if (!done.readonly) {
      notice.value = `已执行，影响 ${done.changes ?? 0} 行`
      // 语句可能增删表，重读表清单
      await loadTables()
    }
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/** 清空执行历史 */
function clearHistory(): void {
  history.value = []
  writeHistory()
  showHistory.value = false
}

/* ───── 结果导出 ───── */

/**
 * 导出当前结果
 * @param as 导出格式
 */
function exportResult(as: "csv" | "json"): void {
  const columns = result.value?.columns
  const rows = result.value?.rows
  if (columns === undefined || rows === undefined) return
  const name = fileNameOf(browsing.value?.name ?? "query")
  if (as === "csv") downloadText(`${name}.csv`, toCsv(columns, rows), "text/csv")
  else downloadText(`${name}.json`, JSON.stringify(rowsAsObjects(columns, rows), null, 2))
}

onMounted(() => void loadHome())
</script>

<template>
  <div>
    <PageHeader route="storage" sub="查看与修改 KV 存储及各插件的 SQLite 库">
      <template #actions>
        <button class="db-btn" :disabled="busy" @click="void refresh()">
          <AppIcon class="btn-ico" :class="{ spinning: busy }" :path="ICONS.refresh" />刷新
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="readonly" class="banner warn">
      面板处于只读模式（配置项 server.readonly 为 true），仅可浏览与执行只读语句。
    </p>

    <!-- 成功回执浮在右下角，片刻后自行收起，不推动版面 -->
    <Transition name="toast">
      <div v-if="notice" class="db-toast" role="status">
        <AppIcon class="btn-ico" :path="ICONS.check" />{{ notice }}
      </div>
    </Transition>

    <div class="toolbar tabs db-tabs" role="tablist">
      <button
        v-for="item in TABS"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        :class="{ primary: tab === item.id }"
        @click="switchTab(item.id)"
      >
        <AppIcon class="btn-ico" :path="item.icon" />{{ item.label }}
      </button>
    </div>

    <Transition name="pane" mode="out-in">
    <!-- ───── 概览 ───── -->
    <div v-if="tab === 'home'" key="home">
      <div class="grid db-stats">
        <div class="card stat db-stat">
          <span class="db-stat-ico"><AppIcon :path="ICONS.key" /></span>
          <h2>KV 键数</h2>
          <b><CountUp :value="kvTotal" /></b>
          <p class="hint">驱动 {{ root?.driver ?? "—" }}</p>
        </div>
        <div class="card stat db-stat">
          <span class="db-stat-ico"><AppIcon :path="ICONS.folder" /></span>
          <h2>顶层命名空间</h2>
          <b><CountUp :value="root?.groups.length ?? 0" /></b>
          <p class="hint">根前缀直属 {{ root?.total ?? 0 }} 个键</p>
        </div>
        <div class="card stat db-stat">
          <span class="db-stat-ico"><AppIcon :path="ICONS.database" /></span>
          <h2>SQLite 库</h2>
          <b><template v-if="sql?.enabled === false">未启用</template><CountUp v-else :value="dbStats.length" /></b>
          <p class="hint">{{ sql?.enabled === false ? "store.sqlite 为 false" : `共 ${bytes(dbBytes)}` }}</p>
        </div>
        <div class="card stat db-stat">
          <span class="db-stat-ico"><AppIcon :path="ICONS.table" /></span>
          <h2>库中行数</h2>
          <b><CountUp :value="dbRows" /></b>
          <p class="hint">{{ dbTables }} 张表与视图</p>
        </div>
      </div>

      <p v-if="root?.truncated" class="banner warn">
        键数超过扫描上限（50000），概览中的计数只含前 50000 个键。
      </p>

      <div class="db-charts">
        <div class="card">
          <h2>顶层命名空间</h2>
          <p class="hint">按键数排序，点一段或图例进入浏览。</p>
          <DonutChart v-if="topDonut.length > 0" :items="topDonut" title="个键" :total="String(kvTotal)" @pick="gotoKv" />
          <EmptyState v-else :icon="ICONS.key" title="存储中还没有键" hint="插件写入 ctx.kv 后会出现在这里。" />
        </div>

        <div v-if="pluginDonut.length > 0" class="card">
          <h2>各插件的数据</h2>
          <p class="hint">plugin:&lt;插件名&gt;: 之下由对应插件独占，面板的修改不会通知插件。</p>
          <DonutChart :items="pluginDonut" title="个键" :total="String(pluginTotal)" @pick="gotoKv" />
        </div>
      </div>

      <div v-if="sql?.enabled !== false" class="card">
        <h2>SQLite 库</h2>
        <EmptyState
          v-if="dbStats.length === 0"
          :icon="ICONS.database"
          title="数据目录中暂无库"
          hint="插件首次调用 ctx.sql() 时创建。"
        />
        <table v-else class="rows">
          <thead>
            <tr>
              <th>库</th>
              <th>表与视图</th>
              <th>行数</th>
              <th>文件大小</th>
              <th>连接</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in dbStats" :key="item.key">
              <td data-label="库" class="mono">{{ item.key }}</td>
              <td data-label="表与视图">{{ item.tables }}</td>
              <td data-label="行数">{{ item.rows ?? "—" }}</td>
              <td data-label="文件大小">{{ bytes(item.size) }}</td>
              <td data-label="连接">
                <span class="tag" :class="item.open ? 'ok' : ''">{{ item.open ? "已连接" : "未连接" }}</span>
              </td>
              <td data-label="操作"><button @click="gotoSql(item.key)">查看</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ───── KV ───── -->
    <div v-else-if="tab === 'kv'" key="kv">
      <div class="db-split">
        <aside class="card db-aside">
          <h2>命名空间</h2>
          <nav class="crumbs" aria-label="当前前缀">
            <button v-for="crumb in crumbs" :key="crumb.prefix" :disabled="crumb.prefix === prefix" @click="enter(crumb.prefix)">
              {{ crumb.label }}
            </button>
          </nav>
          <button v-if="prefix !== ''" class="link db-back" @click="enter(parentOf(prefix))">
            <AppIcon class="btn-ico" :path="ICONS.back" />返回上一级
          </button>
          <ul v-if="page && page.groups.length > 0" class="plain ns-list">
            <li v-for="group in page.groups" :key="group.name">
              <button class="ns-item" @click="enter(prefix + group.name)">
                <AppIcon class="ns-ico" :path="ICONS.folder" />
                <span class="mono ns-name">{{ group.name }}</span>
                <span class="ns-count">{{ group.count }}</span>
                <span class="ns-bar" :style="{ transform: `scaleX(${group.count / groupMax})` }"></span>
              </button>
            </li>
          </ul>
          <p v-else class="hint">此前缀下没有子命名空间。</p>
        </aside>

        <section class="db-main">
          <p v-if="page" class="hint">
            驱动 <span class="mono">{{ page.driver }}</span>。当前前缀
            <span class="mono">{{ prefix || "（根）" }}</span>，直属 {{ page.total }} 个键，连子命名空间共 {{ countHere }} 个。
          </p>

          <div class="toolbar">
            <input
              v-model="jump"
              type="search"
              placeholder="输入前缀直达，如 plugin:webui:"
              aria-label="前缀"
              @keyup.enter="enter(jump)"
            />
            <button class="db-btn" @click="enter(jump)"><AppIcon class="btn-ico" :path="ICONS.next" />前往</button>
            <button v-if="!readonly" class="primary db-btn" @click="openNew()">
              <AppIcon class="btn-ico" :path="ICONS.plus" />新建键
            </button>
          </div>

          <div class="toolbar">
            <input v-model="kvFilter" type="search" placeholder="在本页按键名筛选" aria-label="筛选键名" />
            <select v-model="kvType" aria-label="按类型筛选">
              <option value="">全部类型</option>
              <option v-for="type in typesHere" :key="type" :value="type">{{ KV_TYPE_LABEL[type] }}</option>
            </select>
            <select v-model="kvSort" aria-label="排序依据">
              <option value="name">按键名</option>
              <option value="size">按大小</option>
              <option value="expire">按过期时间</option>
            </select>
            <button class="db-btn" :aria-label="kvDesc ? '降序' : '升序'" @click="kvDesc = !kvDesc">
              <AppIcon class="btn-ico" :path="kvDesc ? ICONS.sortDesc : ICONS.sortAsc" />{{ kvDesc ? "降序" : "升序" }}
            </button>
            <label v-if="sensitiveHere" class="check">
              <input v-model="revealed" type="checkbox" />
              <span class="checkmark"></span>
              显示账号与适配器数据
            </label>
          </div>

          <div v-if="page && shown.length > 0" class="card">
            <table class="rows">
              <thead>
                <tr>
                  <th v-if="!readonly" class="db-sel">
                    <label class="check" aria-label="全选本页">
                      <input type="checkbox" :checked="allPicked" @change="toggleAll()" />
                      <span class="checkmark"></span>
                    </label>
                  </th>
                  <th>键</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>预览</th>
                  <th>过期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in shown" :key="item.key">
                  <td v-if="!readonly" data-label="勾选" class="db-sel">
                    <label class="check" :aria-label="`勾选 ${item.key}`">
                      <input type="checkbox" :checked="picked.has(item.key)" @change="togglePick(item.key)" />
                      <span class="checkmark"></span>
                    </label>
                  </td>
                  <td data-label="键" class="mono">
                    <button class="kv-key" @click="void openEntry(item.key)">{{ item.key.slice(prefix.length) }}</button>
                  </td>
                  <td data-label="类型">
                    <span class="kv-type" :class="`kv-type-${item.type}`">
                      <i aria-hidden="true">{{ TYPE_GLYPH[item.type] }}</i>{{ KV_TYPE_LABEL[item.type] }}
                    </span>
                  </td>
                  <td data-label="大小">{{ bytes(item.size) }}</td>
                  <td data-label="预览" class="kv-preview">
                    <span v-if="isSensitive(item.key) && !revealed" class="hint">（已隐去）</span>
                    <template v-else>{{ item.preview }}</template>
                  </td>
                  <td data-label="过期">{{ ttlText(item.expireAt, now) || "永不" }}</td>
                  <td data-label="操作">
                    <div class="row db-row-ops">
                      <button
                        class="icon-btn"
                        :aria-label="readonly ? '查看' : '编辑'"
                        :title="readonly ? '查看' : '编辑'"
                        @click="void openEntry(item.key)"
                      >
                        <AppIcon :path="readonly ? ICONS.eye : ICONS.edit" />
                      </button>
                      <button class="icon-btn" aria-label="复制键名" title="复制键名" @click="void copy(item.key, '键名')">
                        <AppIcon :path="ICONS.copy" />
                      </button>
                      <button
                        v-if="!readonly"
                        class="icon-btn danger"
                        aria-label="删除"
                        title="删除"
                        @click="void removeEntry(item.key)"
                      >
                        <AppIcon :path="ICONS.trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else-if="page && page.items.length > 0" class="card">
            <EmptyState :icon="ICONS.filter" title="筛选条件下本页没有键" hint="换个关键词，或把类型改回「全部类型」。" />
          </div>
          <div v-else-if="page && page.groups.length === 0" class="card">
            <EmptyState :icon="ICONS.key" title="该前缀下没有键" :hint="readonly ? undefined : '可以在这里新建一个。'">
              <button v-if="!readonly" class="primary" @click="openNew()">
                <AppIcon class="btn-ico" :path="ICONS.plus" />新建键
              </button>
            </EmptyState>
          </div>

          <div v-if="page && (cursors.length > 1 || page.next !== undefined)" class="row db-pager">
            <button :disabled="cursors.length <= 1 || busy" @click="prevPage()">
              <AppIcon class="btn-ico" :path="ICONS.prev" />上一页
            </button>
            <button :disabled="page.next === undefined || busy" @click="nextPage()">
              下一页<AppIcon class="btn-ico" :path="ICONS.next" />
            </button>
            <span class="hint">第 {{ cursors.length }} 页，每页 {{ KV_PAGE }} 个键</span>
          </div>

          <p v-if="page?.truncated" class="hint">键数超过扫描上限，仅统计前 50000 个。请进入下级前缀查看。</p>

          <div v-if="!readonly && page" class="card danger-zone">
            <h2><AppIcon class="btn-ico" :path="ICONS.alert" />危险操作</h2>
            <p class="hint">以下操作会删除数据，立即生效且无法撤销。执行前须键入指定文字确认。</p>
            <div class="row">
              <button class="danger" :disabled="picked.size === 0" @click="askRemovePicked()">
                删除勾选的 {{ picked.size }} 个键
              </button>
              <button class="danger" :disabled="prefix === '' || countHere === 0" @click="askClearPrefix(prefix)">
                删除 {{ prefix || "根前缀" }} 下的全部键（约 {{ countHere }} 个）
              </button>
            </div>
            <p v-if="prefix === ''" class="hint">根前缀不提供整体删除，请先进入一个命名空间。</p>
          </div>
        </section>
      </div>
    </div>

    <!-- ───── SQLite ───── -->
    <div v-else key="sql">
      <p v-if="sql && !sql.enabled" class="banner warn">
        SQLite 未启用（配置项 store.sqlite 为 false），在配置页开启后重启生效。
      </p>

      <div v-if="sql && sql.databases.length > 0" class="db-dbs">
        <button
          v-for="item in sql.databases"
          :key="`${item.plugin}/${item.name}`"
          class="db-db"
          :class="{ on: db === `${item.plugin}/${item.name}` }"
          @click="void pickDb(`${item.plugin}/${item.name}`)"
        >
          <AppIcon class="db-db-ico" :path="ICONS.database" />
          <span class="mono db-db-name">{{ item.plugin }}/{{ item.name }}</span>
          <span class="db-db-size">{{ bytes(item.size) }}</span>
          <span class="db-db-dot" :class="{ ok: item.open }" :title="item.open ? '已连接' : '未连接'"></span>
        </button>
      </div>
      <div v-else-if="sql" class="card">
        <EmptyState :icon="ICONS.database" title="数据目录中暂无库" hint="插件首次调用 ctx.sql() 时创建。" />
      </div>

      <div v-if="sql && sql.databases.length > 0 && db === ''" class="card">
        <EmptyState :icon="ICONS.table" title="选一个库开始" hint="点上方任一库，查看它的表、结构与数据。" />
      </div>

      <div v-if="db !== ''" class="db-split">
        <aside class="card db-aside">
          <h2>表 <span class="ns-count">{{ tables.length }}</span></h2>
          <p v-if="tables.length === 0" class="hint">该库中没有表。</p>
          <ul v-else class="plain ns-list">
            <li v-for="table in tables" :key="table.name">
              <button class="ns-item" :class="{ on: browsing?.name === table.name }" @click="pickTable(table)">
                <AppIcon class="ns-ico" :path="table.type === 'view' ? ICONS.eye : ICONS.table" />
                <span class="mono ns-name">{{ table.name }}</span>
                <span class="ns-count">{{ table.columns.length }} 列</span>
              </button>
            </li>
          </ul>
        </aside>

        <section class="db-main">
          <template v-if="browsing">
            <div class="toolbar tabs db-tabs" role="tablist">
              <button role="tab" :aria-selected="tableView === 'data'" :class="{ primary: tableView === 'data' }" @click="showData()">
                <AppIcon class="btn-ico" :path="ICONS.table" />数据
              </button>
              <button role="tab" :aria-selected="tableView === 'struct'" :class="{ primary: tableView === 'struct' }" @click="void loadStruct()">
                <AppIcon class="btn-ico" :path="ICONS.columns" />结构
              </button>
              <button role="tab" :aria-selected="tableView === 'ddl'" :class="{ primary: tableView === 'ddl' }" @click="void loadDdl()">
                <AppIcon class="btn-ico" :path="ICONS.code" />建表语句
              </button>
            </div>

            <!-- 结构 -->
            <div v-if="tableView === 'struct'" class="card">
              <h2>{{ browsing.name }} 的列</h2>
              <table class="rows db-struct">
                <thead>
                  <tr>
                    <th>列</th>
                    <th>声明类型</th>
                    <th>主键</th>
                    <th>可空</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="column in browsing.columns" :key="column.name">
                    <td data-label="列" class="mono">{{ column.name }}</td>
                    <td data-label="声明类型" class="mono">{{ column.type || "—" }}</td>
                    <td data-label="主键">{{ column.pk > 0 ? `是（第 ${column.pk} 列）` : "否" }}</td>
                    <td data-label="可空">{{ column.notnull ? "NOT NULL" : "可空" }}</td>
                  </tr>
                </tbody>
              </table>
              <h2 class="db-subhead">索引</h2>
              <p v-if="indexes.length === 0" class="hint">该表没有显式索引。</p>
              <ul v-else class="plain db-indexes">
                <li v-for="item in indexes" :key="item.name">
                  <AppIcon class="ns-ico" :path="ICONS.layers" />
                  <span class="mono">{{ item.name }}</span>
                  <span class="hint mono">{{ item.sql || "（由约束自动创建）" }}</span>
                </li>
              </ul>
            </div>

            <!-- 建表语句 -->
            <div v-else-if="tableView === 'ddl'" class="card">
              <div class="db-result-head">
                <h2>{{ browsing.name }} 的建表语句</h2>
                <button class="db-btn" :disabled="ddl === ''" @click="void copy(ddl, '建表语句')">
                  <AppIcon class="btn-ico" :path="ICONS.copy" />复制
                </button>
              </div>
              <pre class="db-ddl"><template v-if="ddl === ''">（没有记录建表语句）</template><span
                v-for="(t, i) in ddlTokens"
                v-else
                :key="i"
                :class="`sql-${t.kind}`"
              >{{ t.text }}</span></pre>
            </div>

            <!-- 数据 -->
            <template v-else>
              <div class="toolbar">
                <div class="db-search">
                  <AppIcon class="db-search-ico" :path="ICONS.filter" />
                  <input
                    v-model="where"
                    type="search"
                    class="mono"
                    placeholder="筛选条件，填 WHERE 之后的部分，如 id > 100"
                    aria-label="筛选条件"
                    @keyup.enter="void browse(browsing, 0)"
                  />
                </div>
                <button class="db-btn" @click="void browse(browsing, 0)">
                  <AppIcon class="btn-ico" :path="ICONS.search" />筛选
                </button>
                <button v-if="where !== ''" class="link" @click="clearWhere()">清除</button>
                <button v-if="editable" class="primary db-btn" @click="openInsert()">
                  <AppIcon class="btn-ico" :path="ICONS.plus" />插入行
                </button>
              </div>
            </template>
          </template>

          <!-- 控制台 -->
          <div v-if="tableView === 'data' || !browsing" class="card db-console">
            <h2><AppIcon class="btn-ico" :path="ICONS.code" />执行语句</h2>
            <textarea
              v-model="query"
              rows="4"
              placeholder="SELECT * FROM ... LIMIT 50"
              aria-label="SQL"
              @keydown.ctrl.enter="void runQuery()"
            />
            <div class="row">
              <button class="primary db-btn" :disabled="busy || query.trim() === ''" @click="void runQuery()">
                <AppIcon class="btn-ico" :path="ICONS.play" />执行
              </button>
              <button v-if="history.length > 0" class="db-btn" @click="showHistory = !showHistory">
                <AppIcon class="btn-ico" :path="ICONS.history" />历史（{{ history.length }}）
              </button>
              <select
                aria-label="语句模板"
                :value="''"
                @change="query = ($event.target as HTMLSelectElement).value"
              >
                <option value="">插入模板…</option>
                <option v-for="item in templates" :key="item.label" :value="item.sql">{{ item.label }}</option>
              </select>
            </div>
            <p class="hint">
              Ctrl+Enter 执行。每次限一条语句，不支持 ATTACH、VACUUM 与事务控制语句，最多返回 {{ QUERY_LIMIT }} 行。
              删改类语句会先征询确认。
            </p>
            <Transition name="fold">
            <ul v-if="showHistory" class="plain db-history">
              <li v-for="(item, i) in history" :key="i">
                <button class="link mono" @click="((query = item), (showHistory = false))">{{ item }}</button>
              </li>
              <li><button class="link" @click="clearHistory()">清空历史</button></li>
            </ul>
            </Transition>
          </div>

          <!-- 结果 -->
          <div v-if="result && tableView === 'data'" class="card">
            <div class="db-result-head">
              <h2>
                <AppIcon class="btn-ico" :path="browsing ? ICONS.table : ICONS.code" />{{
                  browsing ? browsing.name : "查询结果"
                }}
              </h2>
              <div class="row">
                <button v-if="result.rows" class="db-btn" @click="exportResult('csv')">
                  <AppIcon class="btn-ico" :path="ICONS.download" />CSV
                </button>
                <button v-if="result.rows" class="db-btn" @click="exportResult('json')">
                  <AppIcon class="btn-ico" :path="ICONS.download" />JSON
                </button>
              </div>
            </div>
            <p class="hint">
              <template v-if="result.rows">
                本页 {{ result.rows.length }} 行<span v-if="result.truncated">（已截断）</span>
                <span v-if="rowTotal !== undefined">，共 {{ rowTotal }} 行</span>
              </template>
              <template v-else>影响 {{ result.changes ?? 0 }} 行</template>
              · {{ result.cost }} ms
              <span v-if="editable"> · 点一行的「编辑」可改整行</span>
            </p>

            <div v-if="result.columns && result.rows" class="sql-grid">
              <table class="table">
                <thead>
                  <tr>
                    <th v-for="col in result.columns" :key="col">
                      <button v-if="browsing" class="link db-sort" @click="sortBy(col)">
                        {{ columnLabel(col) }}
                        <AppIcon
                          v-if="orderBy === col"
                          class="btn-ico"
                          :path="orderDesc ? ICONS.sortDesc : ICONS.sortAsc"
                        />
                      </button>
                      <template v-else>{{ columnLabel(col) }}</template>
                    </th>
                    <th v-if="editable">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, r) in result.rows" :key="r">
                    <td v-for="(cell, c) in row" :key="c" :class="{ 'cell-null': cell === null }">
                      {{ cellText(cell) }}
                    </td>
                    <td v-if="editable">
                      <div class="row db-row-ops">
                        <button class="icon-btn" aria-label="编辑此行" title="编辑" @click="openRow(r)">
                          <AppIcon :path="ICONS.edit" />
                        </button>
                        <button class="icon-btn danger" aria-label="删除此行" title="删除" @click="void removeRow(r)">
                          <AppIcon :path="ICONS.trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="browsing" class="row db-pager">
              <button
                class="db-btn"
                :disabled="offset === 0 || busy"
                @click="void browse(browsing, Math.max(0, offset - SQL_PAGE))"
              >
                <AppIcon class="btn-ico" :path="ICONS.prev" />上一页
              </button>
              <button
                class="db-btn"
                :disabled="(result.rows?.length ?? 0) < SQL_PAGE || busy"
                @click="void browse(browsing, offset + SQL_PAGE)"
              >
                下一页<AppIcon class="btn-ico" :path="ICONS.next" />
              </button>
              <span class="hint">
                第 {{ offset + 1 }}–{{ offset + (result.rows?.length ?? 0) }} 行<template v-if="rowTotal !== undefined">，共 {{ rowTotal }} 行</template>
              </span>
            </div>
            <p v-if="browsing && !browsing.rowid && !readonly" class="hint">
              {{ browsing.type === "view" ? "视图" : "该表无 rowid" }}，不支持就地修改与删除，请使用上方的语句框。
            </p>
          </div>
        </section>
      </div>
    </div>
    </Transition>

    <!-- KV 键的查看与编辑，宽屏贴右展开 -->
    <Modal
      :open="editing"
      wide
      side
      :title="isNew ? '新建键' : editKey"
      :sub="isNew ? '写入后即对插件生效' : `${KV_TYPE_LABEL[kvTypeOf(treeValue)]} · ${bytes(editBytes)} · ${ttlText(editExpireAt, now) || '永不过期'}`"
      @close="editing = false"
    >
      <p v-if="editError !== ''" class="banner">{{ editError }}</p>

      <div v-if="isNew" class="field">
        <label for="kvKey">键</label>
        <input id="kvKey" v-model="editKey" class="mono" placeholder="plugin:示例:键名" />
      </div>

      <p v-if="editHidden" class="banner warn">
        账号与适配器数据含连接令牌，默认隐藏。
        <button class="link" type="button" @click="editHidden = false">仍要显示</button>
      </p>

      <template v-else>
        <div class="db-seg" role="tablist">
          <button role="tab" :aria-selected="editView === 'tree'" :class="{ on: editView === 'tree' }" @click="editView = 'tree'">
            <AppIcon class="btn-ico" :path="ICONS.tree" />结构
          </button>
          <button role="tab" :aria-selected="editView === 'edit'" :class="{ on: editView === 'edit' }" @click="editView = 'edit'">
            <AppIcon class="btn-ico" :path="ICONS.edit" />{{ readonly ? "原文" : "编辑" }}
          </button>
          <button
            role="tab"
            :aria-selected="editView === 'diff'"
            :class="{ on: editView === 'diff' }"
            :disabled="!changed"
            @click="editView = 'diff'"
          >
            <AppIcon class="btn-ico" :path="ICONS.diff" />改动
            <span v-if="changed" class="db-seg-badge"><i class="add">+{{ diffCount.add }}</i><i class="del">-{{ diffCount.del }}</i></span>
          </button>
        </div>

        <!-- 结构 -->
        <div v-if="editView === 'tree'" class="db-tree">
          <p v-if="!parsed.ok" class="hint">文本当前不是合法 JSON，无法按结构展示。</p>
          <JsonTree v-else :value="treeValue" />
        </div>

        <!-- 差异 -->
        <div v-else-if="editView === 'diff'" class="db-diff">
          <p v-for="(line, i) in diff" :key="i" class="diff-line" :class="`diff-${line.op}`">
            <template v-if="line.op === 'gap'">… 省略 {{ line.count }} 行未改动</template>
            <template v-else>{{ line.op === "add" ? "+" : line.op === "del" ? "-" : " " }} {{ line.text }}</template>
          </p>
        </div>

        <!-- 编辑 -->
        <div v-else class="db-editor" :class="{ bad: !parsed.ok }">
          <div class="db-editor-bar">
            <select v-model="editMode" class="db-editor-mode" aria-label="值的写法" :disabled="readonly">
              <option value="json">JSON</option>
              <option value="text">文本（存为字符串）</option>
            </select>
            <template v-if="editMode === 'json' && !readonly">
              <button class="db-chip" @click="format(true)"><AppIcon class="btn-ico" :path="ICONS.code" />格式化</button>
              <button class="db-chip" @click="format(false)">压缩</button>
            </template>
          </div>
          <textarea
            id="kvValue"
            v-model="editText"
            rows="16"
            class="mono db-editor-text"
            aria-label="值"
            spellcheck="false"
            :readonly="readonly"
          />
          <p class="db-editor-status" :class="{ err: !parsed.ok }">
            <AppIcon class="btn-ico" :path="parsed.ok ? ICONS.check : ICONS.alert" />
            <span>{{ parsed.ok ? `合法 · ${bytes(editBytes)} · ${lineCount} 行` : parsed.error }}</span>
          </p>
        </div>

        <section v-if="!readonly" class="db-ttl">
          <h3><AppIcon class="btn-ico" :path="ICONS.clock" />有效期</h3>
          <div class="db-chips">
            <button v-if="!isNew" class="db-chip" :class="{ on: ttlChoice === 'keep' }" @click="ttlChoice = 'keep'">保持原样</button>
            <button class="db-chip" :class="{ on: ttlChoice === 'never' }" @click="ttlChoice = 'never'">永不过期</button>
            <button
              v-for="preset in TTL_PRESETS"
              :key="preset.sec"
              class="db-chip"
              :class="{ on: ttlChoice === preset.sec }"
              @click="ttlChoice = preset.sec"
            >
              {{ preset.label }}
            </button>
            <button class="db-chip" :class="{ on: ttlChoice === 'custom' }" @click="ttlChoice = 'custom'">自定义</button>
          </div>
          <input
            v-if="ttlChoice === 'custom'"
            v-model="ttlCustom"
            inputmode="decimal"
            placeholder="多少秒后过期"
            aria-label="多少秒后过期"
          />
          <p class="hint">{{ ttlNote }}</p>
        </section>

        <div class="db-entry-ops">
          <button class="db-chip" @click="void copy(editText, '值')"><AppIcon class="btn-ico" :path="ICONS.copy" />复制值</button>
          <button class="db-chip" @click="downloadEntry()"><AppIcon class="btn-ico" :path="ICONS.download" />下载</button>
          <button v-if="!isNew && !readonly" class="db-chip" @click="openCopy(false)">
            <AppIcon class="btn-ico" :path="ICONS.file" />另存为…
          </button>
          <button v-if="!isNew && !readonly" class="db-chip" @click="openCopy(true)">
            <AppIcon class="btn-ico" :path="ICONS.edit" />改名…
          </button>
        </div>
      </template>

      <template #actions>
        <button v-if="!isNew && !readonly" class="danger" @click="void removeEntry(editKey)">删除</button>
        <button @click="editing = false">{{ readonly ? "关闭" : "取消" }}</button>
        <button v-if="!readonly" class="primary" :disabled="busy || editHidden || !parsed.ok" @click="void saveEntry()">
          保存
        </button>
      </template>
    </Modal>

    <!-- 另存与改名 -->
    <Modal
      :open="copyTo"
      :title="copyMove ? '改名' : '另存为'"
      :sub="copyMove ? '先写入新键，再删除原键；两步之间若出错会留下两个键' : '以当前值写入另一个键，原键保持不变'"
      @close="copyTo = false"
    >
      <div class="field">
        <label for="kvCopy">目标键</label>
        <input id="kvCopy" v-model="copyKey" class="mono" @keyup.enter="void saveCopy()" />
      </div>
      <template #actions>
        <button @click="copyTo = false">取消</button>
        <button class="primary" :disabled="busy" @click="void saveCopy()">{{ copyMove ? "改名" : "另存" }}</button>
      </template>
    </Modal>

    <!-- SQLite 整行编辑 -->
    <Modal
      :open="rowDraft !== undefined"
      wide
      side
      :title="rowDraft?.rowid === undefined ? `在 ${browsing?.name ?? ''} 中插入行` : `编辑 ${browsing?.name ?? ''}`"
      :sub="rowDraft?.rowid === undefined ? '留空且未置 NULL 的列按空字符串写入' : `rowid ${rowDraft?.rowid}`"
      @close="rowDraft = undefined"
    >
      <template v-if="rowDraft">
        <div v-for="cell in rowDraft.cells" :key="cell.name" class="field">
          <label :for="`cell-${cell.name}`">
            {{ cell.name }}
            <span class="hint">{{ browsing?.columns.find(c => c.name === cell.name)?.type || "无声明类型" }}</span>
          </label>
          <p v-if="cell.blob" class="hint">二进制列不支持在面板修改，保存时保持原值。</p>
          <template v-else>
            <textarea :id="`cell-${cell.name}`" v-model="cell.text" rows="2" class="mono" :disabled="cell.isNull" />
            <label class="check">
              <input v-model="cell.isNull" type="checkbox" />
              <span class="checkmark"></span>
              置为 NULL
            </label>
          </template>
        </div>
      </template>
      <template #actions>
        <button @click="rowDraft = undefined">取消</button>
        <button class="primary" :disabled="busy" @click="void saveRow()">保存</button>
      </template>
    </Modal>

    <!-- 须键入确认文字的删除 -->
    <DangerConfirm
      :open="danger !== undefined"
      :title="danger?.title ?? ''"
      :body="danger?.body ?? ''"
      :expected="danger?.expected ?? ''"
      :warning="danger?.warning"
      :samples="danger?.samples"
      :ok-text="danger?.okText"
      :busy="busy"
      @close="danger = undefined"
      @confirm="void runDanger()"
    />
  </div>
</template>
