<script setup lang="ts">
/**
 * 模块职责：概览页的运行时信息表 —— 版本、状态、环境、面板、主目录
 * 依赖方向：依赖 format 与 context；不认识栅格
 * 生命周期：随所在格子
 * 注意事项：行高由格子决定：格子若被缩到装不下五行，卡片内部自行滚动
 *          （见 styles.css 中 `.board .card` 的 overflow），而不是把内容溢出到邻格上。
 */
import { computed, inject } from "vue"
import { datetime, duration, runtimeStatusText } from "../format.js"
import { OVERVIEW } from "./context.js"

const data = inject(OVERVIEW, undefined)

/** 当前快照 */
const snapshot = computed(() => data?.value)
</script>

<template>
  <div class="card">
    <h2 style="margin-top: 0">运行时</h2>
    <table v-if="snapshot" class="pairs">
      <tbody>
        <tr>
          <th>版本</th>
          <td>Yunzai NG {{ snapshot.version }}</td>
        </tr>
        <tr>
          <th>状态</th>
          <td>
            <span class="tag" :class="snapshot.status === 'running' ? 'ok' : 'warn'">
              {{ runtimeStatusText(snapshot.status) }}
            </span>
            已运行 {{ duration(snapshot.uptime) }}（{{ datetime(snapshot.startedAt) }} 启动）
          </td>
        </tr>
        <tr>
          <th>环境</th>
          <td>
            {{ snapshot.platform.os }}/{{ snapshot.platform.arch }}
            <span v-if="snapshot.platform.isTermux" class="tag">Termux</span>
            <span v-if="snapshot.platform.isContainer" class="tag">容器</span>
            · Node {{ snapshot.platform.nodeVersion }} · {{ snapshot.platform.cpus }} 核
          </td>
        </tr>
        <tr>
          <th>面板</th>
          <td>
            {{ snapshot.server.host }}:{{ snapshot.server.port }}
            <span v-if="snapshot.server.readonly" class="tag warn">只读模式</span>
            <span class="tag">{{ snapshot.server.connections }} 个长连接</span>
          </td>
        </tr>
        <tr>
          <th>主目录</th>
          <td class="mono">{{ snapshot.paths.home }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="sub">加载中…</p>
  </div>
</template>
