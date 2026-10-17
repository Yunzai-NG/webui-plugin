<script setup lang="ts">
/**
 * 模块职责：概览页的消息组件 —— 近 24 小时收发总数、逐时柱与今日最活跃的会话
 * 依赖方向：依赖 context（页面拉来的摘要）与 router（跳去统计页）
 * 生命周期：随所在格子
 * 注意事项：**柱子按两段叠：底下发出、上面收到。** 两者量级常差一个数量级，分两组柱并排时
 *          发出那组矮到读不出；叠起来先读总量，再看发出占了多少。
 *
 *          「没在采集」与「没人说话」分开说：前者 24 格同样全是 0，而它要使用者去看插件页，
 *          后者什么都不用做。
 */
import { computed, inject } from "vue"
import { MESSAGES } from "./context.js"

const feed = inject(MESSAGES, undefined)

/** 摘要；一次都没拿到过时为 undefined */
const brief = computed(() => feed?.value.data)

/**
 * 一次都没拿到过时的说明
 *
 * 回来的是网页而非 JSON，多半是面板前端已更新、webui 插件还没重载 —— 那条路由随插件注册。
 * 照搬解析错误（「Unexpected token '<'」）等于让使用者去猜。
 */
const failure = computed(() => {
  const error = brief.value === undefined ? feed?.value.error : undefined
  if (error === undefined) return undefined
  return /Unexpected token|not valid JSON|404/i.test(error) ? "重载一次 webui 插件后才有这一格的数据（插件页 → webui → 重载）" : `取不到消息统计：${error}`
})

/** 千位分隔，四位数以上读起来才不必数位 */
const fmt = new Intl.NumberFormat("zh-CN")

/** 逐时柱，附上相对高度；最高的一根顶满 */
const bars = computed(() => {
  const hours = brief.value?.hours ?? []
  const peak = Math.max(1, ...hours.map(slot => slot.recv + slot.sent))
  return hours.map((slot, i) => ({
    ...slot,
    recvPct: (slot.recv / peak) * 100,
    sentPct: (slot.sent / peak) * 100,
    // 横轴只标四处与末格：24 个标签挤在半宽格子里互相压住
    tick: i === hours.length - 1 ? "现在" : i % 6 === 0 ? `${slot.label.slice(-2)}时` : ""
  }))
})

/** 24 格是否全空 */
const silent = computed(() => bars.value.every(slot => slot.recv + slot.sent === 0))

/** 读屏器读的那一句；柱子本身对它不可见 */
const summary = computed(() => {
  const now = brief.value
  if (now === undefined) return ""
  let top: (typeof bars.value)[number] | undefined
  for (const slot of bars.value) {
    if (top === undefined || slot.recv + slot.sent > top.recv + top.sent) top = slot
  }
  return `近 24 小时收到 ${now.last24.recv.messages} 条、发出 ${now.last24.sent.messages} 条` +
    (top === undefined || silent.value ? "" : `，最忙的是 ${top.at} 时`)
})
</script>

<template>
  <div class="card msgs">
    <header class="wcard-head">
      <h2>消息</h2>
      <span class="tag">近 24 小时</span>
    </header>

    <template v-if="brief">
      <p v-if="!brief.running" class="sub">消息统计尚未开始：采集器没有启动，到插件页看 webui 的日志。</p>
      <template v-else>
        <dl class="msgs-figures">
          <div>
            <dt><i class="swatch recv" aria-hidden="true"></i>收到</dt>
            <dd>{{ fmt.format(brief.last24.recv.messages) }}</dd>
          </div>
          <div>
            <dt><i class="swatch sent" aria-hidden="true"></i>发出</dt>
            <dd>{{ fmt.format(brief.last24.sent.messages) }}</dd>
          </div>
          <div class="msgs-today">
            <dt>今日</dt>
            <dd>
              {{ fmt.format(brief.today.recv.messages) }}<small> 收</small> ·
              {{ fmt.format(brief.today.sent.messages) }}<small> 发</small>
            </dd>
          </div>
        </dl>

        <div class="msgs-chart" role="img" :aria-label="summary">
          <div
            v-for="slot in bars"
            :key="slot.at"
            class="msgs-col"
            :title="`${slot.at} 时 · 收 ${slot.recv} · 发 ${slot.sent}`"
          >
            <span class="msgs-bar sent" :class="{ some: slot.sent > 0 }" :style="{ height: `${slot.sentPct}%` }"></span>
            <span class="msgs-bar recv" :class="{ some: slot.recv > 0 }" :style="{ height: `${slot.recvPct}%` }"></span>
          </div>
          <p v-if="silent" class="msgs-empty">近 24 小时没有收发</p>
        </div>
        <div class="msgs-axis" aria-hidden="true">
          <span v-for="slot in bars" :key="slot.at">{{ slot.tick }}</span>
        </div>

        <p v-if="brief.peers.length > 0" class="msgs-peers">
          <span class="msgs-peers-label">今日最活跃</span>
          <span v-for="peer in brief.peers" :key="peer.name" class="msgs-peer">
            {{ peer.name }}<b>{{ fmt.format(peer.messages) }}</b>
          </span>
        </p>
      </template>
    </template>
    <p v-else class="sub">{{ failure ?? "加载中…" }}</p>
  </div>
</template>
