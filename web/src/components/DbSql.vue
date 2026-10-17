<script setup lang="ts">
/**
 * 模块职责：数据库页的「SQLite」页签 —— 选库，浏览表的数据、结构与建表语句，改删行，执行单条语句
 * 依赖方向：依赖 api / confirm / dbpage / download / format / icons / storage / types 与 components 下的若干组件
 * 生命周期：随数据库页常驻；首次显示时读库清单，`target` 给出时直接打开那个库
 * 注意事项：删行与删改类语句一律经确认；控制台的结果不对应某张表，其中的行不可改
 */
import { computed, ref, watch } from "vue"
import { get } from "../api.js"
import { askConfirm } from "../confirm.js"
import { dbPath, execOn, useDbPage } from "../dbpage.js"
import { showToast } from "../toast.js"
import { downloadText, fileNameOf } from "../download.js"
import { bytes, errorText } from "../format.js"
import { ICONS } from "../icons.js"
import {
  DDL_SQL,
  INDEX_SQL,
  ROWID_ALIAS,
  browseSqlOf,
  cellEditText,
  cellParamOf,
  cellText,
  columnLabel,
  countSqlOf,
  deleteSqlOf,
  insertSqlOf,
  isBlobCell,
  isDestructiveSql,
  pushHistory,
  rowsAsObjects,
  sqlTemplatesOf,
  sqlTokens,
  toCsv,
  updateRowSqlOf
} from "../storage.js"
import AppIcon from "./AppIcon.vue"
import EmptyState from "./EmptyState.vue"
import Modal from "./Modal.vue"
import TabBar from "./TabBar.vue"
import type { SqlOverview, SqlResult, SqlTable } from "../types.js"

/** 浏览一张表时的三个视图 */
const TABLE_TABS = [
  { id: "data", label: "数据", icon: ICONS.table },
  { id: "struct", label: "结构", icon: ICONS.columns },
  { id: "ddl", label: "建表语句", icon: ICONS.code }
] as const

/** 浏览表时每页行数 */
const SQL_PAGE = 100

/** 控制台返回的行数上限 */
const QUERY_LIMIT = 500

/** 执行历史在 localStorage 中的键 */
const HISTORY_KEY = "yunzai-ng.sql-history"

const props = defineProps<{
  /** 从概览跳来时要打开的库；每次跳转换一个新对象，同一个库也会重新打开 */
  target?: { db: string }
}>()

const { error, busy, readonly, copy } = useDbPage()

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

/** 结果能否按 rowid 改删 */
const editable = computed(
  () => !readonly.value && browsing.value?.rowid === true && result.value?.columns?.[0] === ROWID_ALIAS
)

const templates = computed(() => sqlTemplatesOf(browsing.value?.name))

/* ────────────────────────────── 取数 ────────────────────────────── */

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

/** 读库清单 */
async function loadSql(): Promise<void> {
  try {
    sql.value = await get<SqlOverview>("storage/sql")
    readonly.value = sql.value.readonly
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

/** 页头的刷新：重读库清单，已选库时连同它的表 */
async function refresh(): Promise<void> {
  await loadSql()
  if (db.value !== "") await pickDb(db.value)
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

/**
 * 切换表的视图；每次切入都重新取数
 * @param view 视图
 */
function pickTableView(view: (typeof TABLE_TABS)[number]["id"]): void {
  if (view === "data") showData()
  else if (view === "struct") void loadStruct()
  else void loadDdl()
}

/* ────────────────────────────── 整行编辑 ────────────────────────────── */

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
      showToast("已插入 1 行")
    } else {
      await run(updateRowSqlOf(table.name, cells.map(c => c.name)), [...params, draft.rowid], 1)
      showToast("已更新 1 行")
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
    showToast("已删除 1 行")
    await browse(table, offset.value)
  } catch (err) {
    error.value = errorText(err)
  }
}

/* ────────────────────────────── 控制台 ────────────────────────────── */

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
      showToast(`已执行，影响 ${done.changes ?? 0} 行`)
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

watch(
  () => props.target,
  async target => {
    if (sql.value === undefined) await loadSql()
    if (target !== undefined) await pickDb(target.db)
  },
  { immediate: true }
)

defineExpose({ refresh })
</script>

<template>
  <div>
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
          <TabBar
            class="db-tabs"
            :items="TABLE_TABS"
            :model-value="tableView"
            :label="`表 ${browsing.name}`"
            @update:model-value="pickTableView"
          />

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

    <!-- 整行编辑 -->
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
  </div>
</template>
