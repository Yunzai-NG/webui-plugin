<script setup lang="ts">
/**
 * 模块职责：概览页的账号组件 —— 每个号一行：状态、名字、接入方式、这个状态持续了多久
 * 依赖方向：依赖 format、router 与 context（页面拉来的账号列表）
 * 生命周期：随所在格子
 * 注意事项：**计数块只说「在线 2 / 2」，这一格说是哪两个。** 掉线时要知道的是掉的是哪个号、
 *          掉了多久、报的什么错 —— 三件事都在这一行里，不必翻到账号页。
 *
 *          至多列 {@link LIMIT} 个，余下的给一个去账号页的链接；更多的管理动作全在那边。
 */
import { computed, inject } from "vue"
import { ago, statusClass, statusText } from "../format.js"
import { hrefOf } from "../router.js"
import { ACCOUNTS } from "./context.js"

/** 至多列几个号 */
const LIMIT = 6

const feed = inject(ACCOUNTS, undefined)

/** 账号列表；一次都没拿到过时为 undefined */
const list = computed(() => feed?.value.data)

/** 一次都没拿到过时的说明 */
const failure = computed(() => (list.value === undefined ? feed?.value.error : undefined))

/** 在线的个数 */
const online = computed(() => list.value?.filter(item => item.status === "online").length ?? 0)

/** 要列出来的那几行 */
const rows = computed(() =>
  (list.value ?? []).slice(0, LIMIT).map(item => ({
    id: item.record.id,
    name: item.nickname ?? item.record.label ?? item.record.selfId ?? item.record.id,
    via: [item.record.adapterId, item.record.selfId].filter(Boolean).join(" · "),
    status: item.status,
    since: item.since,
    error: item.status === "error" ? item.error : undefined
  }))
)

/** 列不下的个数 */
const more = computed(() => Math.max(0, (list.value?.length ?? 0) - LIMIT))
</script>

<template>
  <div class="card accts">
    <header class="wcard-head">
      <h2>账号</h2>
      <span
        v-if="list && list.length > 0"
        class="tag"
        :class="online === list.length ? 'ok' : 'warn'"
      >
        {{ online }} / {{ list.length }} 在线
      </span>
    </header>

    <ul v-if="list && list.length > 0" class="wlist">
      <li v-for="row in rows" :key="row.id">
        <i class="dot" :class="statusClass(row.status)" aria-hidden="true"></i>
        <div class="wlist-main">
          <b>{{ row.name }}</b>
          <span v-if="row.via" class="mono">{{ row.via }}</span>
          <span v-if="row.error" class="wlist-err">{{ row.error }}</span>
        </div>
        <span class="wlist-side">{{ statusText(row.status) }} · {{ ago(row.since) }}</span>
      </li>
    </ul>
    <p v-else-if="list" class="sub">还没有任何账号。<a :href="hrefOf('accounts')">去账号页添加</a></p>
    <p v-else class="sub">{{ failure === undefined ? "加载中…" : `取不到账号列表：${failure}` }}</p>

    <a v-if="more > 0" class="wlist-more" :href="hrefOf('accounts')">还有 {{ more }} 个，到账号页查看</a>
  </div>
</template>
