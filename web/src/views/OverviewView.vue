<script setup lang="ts">
/**
 * 模块职责：概览页 —— 拉取快照，并把它交给板上的组件
 * 依赖方向：依赖 api / format / types / GridBoard / widgets/context
 * 生命周期：挂载时拉取一次，随后每 5 秒刷新；卸载时停止
 * 注意事项：轮询而非 WebSocket 推送 —— 概览的数值都是低频查看的指标，不值得为它多一条长连接；
 *          5 秒的间隔也够让连接账号一类的操作结果及时反映出来。
 *
 *          **本页不直接书写任何卡片**：只拉数据、`provide` 出去、摆一块组件板。板上有哪些组件由
 *          `widgets/overview.ts` 登记，各组件自行 `inject` 这一份快照 —— 各自发请求的话每 5 秒是
 *          七个请求，且七份快照还会互相矛盾。
 *
 *          「还没有任何账号」那条提示留在板外：它是特定条件下才出现的指引，不是可摆放的组件，
 *          被移除或拖到角落都会使它失去作用。
 */
import { onMounted, onUnmounted, provide, ref } from "vue"
import GridBoard from "../components/GridBoard.vue"
import PageHeader from "../components/PageHeader.vue"
import { get } from "../api.js"
import { errorText } from "../format.js"
import { OVERVIEW, SYSTEM } from "../widgets/context.js"
import type { Overview, SystemInfo } from "../types.js"

/** 编辑态 */
const edit = ref(false)

/** 刷新间隔 */
const REFRESH_MS = 5000

const data = ref<Overview | undefined>(undefined)
const system = ref<SystemInfo | undefined>(undefined)
const error = ref("")
let timer: number | undefined

provide(OVERVIEW, data)
provide(SYSTEM, system)

/** 拉取一次概览 */
async function load(): Promise<void> {
  try {
    data.value = await get<Overview>("overview")
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  }
}

/**
 * 拉取一次系统信息（磁盘与显卡）
 *
 * **失败不写 `error`。** 那条横幅是页级的，而这份数据只喂磁盘与显卡两个组件 ——
 * 探测失败时整页顶上出现红字，会让人以为内核出了问题。两个组件各自在没数据时
 * 说明自己的情形（「探不到任何分区」/「测不到显卡」）。
 */
async function loadSystem(): Promise<void> {
  try {
    system.value = await get<SystemInfo>("system")
  } catch {
    // 保留上一次的值：一次超时不该让已经画出来的进度条整片消失
  }
}

onMounted(() => {
  void load()
  void loadSystem()
  timer = window.setInterval(() => {
    void load()
    void loadSystem()
  }, REFRESH_MS)
})

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer)
})
</script>

<template>
  <div>
    <PageHeader route="overview" sub="内核状态、资源占用与各子系统计数">
      <template #actions>
        <button type="button" :class="{ primary: edit }" @click="edit = !edit">
          {{ edit ? "完成" : "编辑组件" }}
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="banner">{{ error }}</p>

    <GridBoard :page="'overview'" :edit="edit" @update:edit="edit = $event" />

    <p v-if="data && data.counts.accounts === 0" class="banner warn">
      还没有任何账号。去「账号」页添加一个 —— 登录本身也是插件提供的，所以先确认已装好适配器插件。
    </p>
  </div>
</template>
