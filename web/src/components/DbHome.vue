<script setup lang="ts">
/**
 * 模块职责：数据库页的「概览」页签 —— KV 的命名空间分布，各 SQLite 库的表数、行数与文件大小
 * 依赖方向：依赖 api / dbpage / format / icons / storage / types 与 components 下的若干组件
 * 生命周期：挂载时读一次，此后只在页头刷新时重读
 * 注意事项：点环形图或库只往外报目标，切页签与进入由数据库页完成
 */
import { computed, onMounted, ref } from "vue"
import { get } from "../api.js"
import { dbPath, execOn, useDbPage } from "../dbpage.js"
import { bytes, errorText } from "../format.js"
import { ICONS } from "../icons.js"
import { countAllSqlOf, sharesOf } from "../storage.js"
import AppIcon from "./AppIcon.vue"
import CountUp from "./CountUp.vue"
import DonutChart from "./DonutChart.vue"
import EmptyState from "./EmptyState.vue"
import type { KvGroup, KvPage, SqlOverview, SqlTable } from "../types.js"

const emit = defineEmits<{
  /** 进入 KV 的某个前缀 */
  gotoKv: [prefix: string]
  /** 进入某个库，形如 `插件/库名` */
  gotoSql: [db: string]
}>()

const { error, busy, readonly } = useDbPage()

/** 根前缀那一页，只取统计用的字段 */
const root = ref<KvPage | undefined>(undefined)
/** `plugin:` 之下的各插件命名空间 */
const pluginGroups = ref<KvGroup[]>([])
/** SQLite 库清单 */
const sql = ref<SqlOverview | undefined>(undefined)

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

/** 读概览：KV 的命名空间分布与各库的表数、行数 */
async function load(): Promise<void> {
  busy.value = true
  try {
    root.value = await get<KvPage>("storage/kv?prefix=&limit=1")
    readonly.value = root.value.readonly
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
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

defineExpose({ refresh: load })

onMounted(() => void load())
</script>

<template>
  <div>
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
        <DonutChart
          v-if="topDonut.length > 0"
          :items="topDonut"
          title="个键"
          :total="String(kvTotal)"
          @pick="emit('gotoKv', $event)"
        />
        <EmptyState v-else :icon="ICONS.key" title="存储中还没有键" hint="插件写入 ctx.kv 后会出现在这里。" />
      </div>

      <div v-if="pluginDonut.length > 0" class="card">
        <h2>各插件的数据</h2>
        <p class="hint">plugin:&lt;插件名&gt;: 之下由对应插件独占，面板的修改不会通知插件。</p>
        <DonutChart :items="pluginDonut" title="个键" :total="String(pluginTotal)" @pick="emit('gotoKv', $event)" />
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
            <td data-label="操作"><button @click="emit('gotoSql', item.key)">查看</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
