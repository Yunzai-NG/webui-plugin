<script setup lang="ts">
/**
 * 模块职责：数据库页 —— 页头与三个页签的切换，及它们共用的错误、忙碌与只读状态
 * 依赖方向：依赖 dbpage / download / format / icons / toast 与 components 下的 DbHome / DbKv / DbSql 等组件
 * 生命周期：概览随页面挂载；KV 与 SQLite 首次切入时才挂载取数，此后由 KeepAlive 留住
 * 注意事项：只读模式下写按钮隐去，门在内核（KV 写路由各判一次，SQL 按 `stmt.readonly` 判）。
 *
 *          **成功回执走全站那一条顶部提示条**（`showToast`），本页不自己摆浮层、也不自己计时：
 *          此前这一页独有一枚右下角的 `.db-toast`，而其余各页的回执是页内常驻的 `.banner.ok`
 *          —— 同一件事两种形制，使用者得分别学一遍。错误仍留在页内横幅里：那一条要等人改掉它。
 */
import { provide, ref } from "vue"
import { DB_PAGE } from "../dbpage.js"
import { copyText } from "../download.js"
import { errorText } from "../format.js"
import { ICONS } from "../icons.js"
import { showToast } from "../toast.js"
import AppIcon from "../components/AppIcon.vue"
import DbHome from "../components/DbHome.vue"
import DbKv from "../components/DbKv.vue"
import DbSql from "../components/DbSql.vue"
import PageHeader from "../components/PageHeader.vue"
import TabBar from "../components/TabBar.vue"

/** 三个页签，概览居首 */
const TABS = [
  { id: "home", label: "概览", icon: ICONS.gauge },
  { id: "kv", label: "KV", icon: ICONS.key },
  { id: "sql", label: "SQLite", icon: ICONS.database }
] as const

const tab = ref<(typeof TABS)[number]["id"]>("home")
const error = ref("")
const busy = ref(false)
const readonly = ref(false)
/** 从概览跳到 KV 时要进入的前缀 */
const kvTarget = ref<{ prefix: string } | undefined>(undefined)
/** 从概览跳到 SQLite 时要打开的库 */
const sqlTarget = ref<{ db: string } | undefined>(undefined)
/** 当前页签的组件，页头的刷新转给它 */
const pane = ref<{ refresh: () => Promise<void> } | null>(null)

/**
 * 复制一段文本并提示结果
 * @param text 文本
 * @param what 提示里对这段文本的称呼
 */
async function copy(text: string, what: string): Promise<void> {
  try {
    await copyText(text)
    showToast(`已复制${what}`)
  } catch (err) {
    error.value = errorText(err)
  }
}

provide(DB_PAGE, { error, busy, readonly, copy })

/**
 * 切页签
 *
 * 不再清回执：那条提示已经不在这一页的版面里（它浮在整页顶上、自己会走完），
 * 而切页签并不能取消刚才那次写入。
 * @param id 页签
 */
function switchTab(id: (typeof TABS)[number]["id"]): void {
  tab.value = id
}

/**
 * 从概览跳到 KV 的某个前缀
 * @param prefix 前缀
 */
function gotoKv(prefix: string): void {
  kvTarget.value = { prefix }
  switchTab("kv")
}

/**
 * 从概览跳到某个库
 * @param db 库键
 */
function gotoSql(db: string): void {
  sqlTarget.value = { db }
  switchTab("sql")
}

/** 页头的刷新 */
async function refresh(): Promise<void> {
  await pane.value?.refresh()
}
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

    <TabBar class="db-tabs" :items="TABS" :model-value="tab" label="数据库" @update:model-value="switchTab" />

    <Transition name="pane" mode="out-in">
      <KeepAlive>
        <DbHome v-if="tab === 'home'" ref="pane" @goto-kv="gotoKv" @goto-sql="gotoSql" />
        <DbKv v-else-if="tab === 'kv'" ref="pane" :target="kvTarget" />
        <DbSql v-else ref="pane" :target="sqlTarget" />
      </KeepAlive>
    </Transition>
  </div>
</template>
