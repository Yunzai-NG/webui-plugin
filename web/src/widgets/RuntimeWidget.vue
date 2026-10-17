<script setup lang="ts">
/**
 * 模块职责：概览页的运行时信息 —— 状态与已运行时长领头，版本、环境、面板、主目录列在其下
 * 依赖方向：依赖 format 与 context；不认识栅格
 * 生命周期：随所在格子
 * 注意事项：**不用表格。** 五行同权的键值表读不出主次，而这一格要先回答的只有一件事：内核在不在跑、
 *          跑了多久。其余四项是查阅用的，排成两栏的事实网格，窄了自行折成一栏。
 *
 *          高度随内容（注册时声明 `fit`），故这里不必为某一档行高抠像素。
 */
import { computed, inject } from "vue"
import { datetime, duration, runtimeStatusText } from "../format.js"
import { OVERVIEW } from "./context.js"

const data = inject(OVERVIEW, undefined)

/** 当前快照 */
const snapshot = computed(() => data?.value)
</script>

<template>
  <div class="card runtime">
    <header class="wcard-head">
      <h2>运行时</h2>
      <span v-if="snapshot" class="tag" :class="snapshot.status === 'running' ? 'ok' : 'warn'">
        {{ runtimeStatusText(snapshot.status) }}
      </span>
    </header>

    <template v-if="snapshot">
      <p class="runtime-up">
        <b>{{ duration(snapshot.uptime) }}</b>
        <span>已运行 · {{ datetime(snapshot.startedAt) }} 启动</span>
      </p>

      <dl class="runtime-facts">
        <div>
          <dt>版本</dt>
          <dd>Yunzai NG {{ snapshot.version }}</dd>
        </div>
        <div>
          <dt>环境</dt>
          <dd>
            {{ snapshot.platform.os }}/{{ snapshot.platform.arch }} · Node {{ snapshot.platform.nodeVersion }} ·
            {{ snapshot.platform.cpus }} 核
            <span v-if="snapshot.platform.isTermux" class="tag">Termux</span>
            <span v-if="snapshot.platform.isContainer" class="tag">容器</span>
          </dd>
        </div>
        <div>
          <dt>面板</dt>
          <dd>
            <span class="mono">{{ snapshot.server.host }}:{{ snapshot.server.port }}</span>
            · {{ snapshot.server.connections }} 个长连接
            <span v-if="snapshot.server.readonly" class="tag warn">只读模式</span>
          </dd>
        </div>
        <div class="wide">
          <dt>主目录</dt>
          <dd class="mono">{{ snapshot.paths.home }}</dd>
        </div>
      </dl>
    </template>
    <p v-else class="sub">加载中…</p>
  </div>
</template>
