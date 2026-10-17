<script setup lang="ts">
/**
 * 模块职责：概览页的近期告警 —— 日志缓冲里最近的几条警告与错误，新的在上
 * 依赖方向：依赖 format、router 与 context（页面拉来的日志）
 * 生命周期：随所在格子
 * 注意事项：**只取 warn 及以上**（服务端按级别筛，见 `logs?level=warn`）：info 一分钟几十条，
 *          摆在概览上就是一面会动的墙。全文、筛选与实时追加都在日志页。
 *
 *          一条都没有时明说「近期没有」，不留一格空白 —— 那正是使用者想听到的答复。
 */
import { computed, inject } from "vue"
import { ago, datetime } from "../format.js"
import { hrefOf } from "../router.js"
import { ALERTS } from "./context.js"

const feed = inject(ALERTS, undefined)

/** 日志；一次都没拿到过时为 undefined */
const records = computed(() => feed?.value.data)

/** 一次都没拿到过时的说明 */
const failure = computed(() => (records.value === undefined ? feed?.value.error : undefined))

/** 新的在上；多行消息只取首行，堆栈留给日志页 */
const rows = computed(() =>
  [...(records.value ?? [])].reverse().map((rec, i) => ({
    key: `${rec.time}-${i}`,
    level: rec.level,
    bad: rec.level === "error" || rec.level === "fatal",
    time: rec.time,
    scope: rec.scope,
    msg: rec.msg.split("\n", 1)[0] ?? rec.msg
  }))
)
</script>

<template>
  <div class="card alerts">
    <header class="wcard-head">
      <h2>近期告警</h2>
      <a class="wlist-link" :href="hrefOf('logs')">查看日志</a>
    </header>

    <ul v-if="rows.length > 0" class="wlist">
      <li v-for="row in rows" :key="row.key">
        <span class="tag" :class="row.bad ? 'err' : 'warn'">{{ row.bad ? "错误" : "警告" }}</span>
        <div class="wlist-main">
          <b class="wlist-msg">{{ row.msg }}</b>
          <span v-if="row.scope" class="mono">{{ row.scope }}</span>
        </div>
        <span class="wlist-side" :title="datetime(row.time)">{{ ago(row.time) }}</span>
      </li>
    </ul>
    <p v-else-if="records" class="sub">近期没有警告或错误。</p>
    <p v-else class="sub">{{ failure === undefined ? "加载中…" : `取不到日志：${failure}` }}</p>
  </div>
</template>
