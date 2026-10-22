<script setup lang="ts">
/**
 * 模块职责：一条成功回执 —— 文案、关闭钮，与下沿那条走完即关的进度条
 * 依赖方向：依赖 toast.ts 的类型与 icons；不认识任何具体页面
 * 生命周期：随一条回执；挂载即开始计时，到点往外报 `done`
 * 注意事项：**计时的权威是 `setTimeout`，进度条只是它的显形。** 反过来（听 `animationend` 关闭）
 *          在这个仓库里是坏的：`styles.css` 末尾那两个「关闭动效」块以 `!important` 把全站
 *          `animation-duration` 压到 1ms，于是回执会在 1ms 后消失 —— 而那两个块的本意只是
 *          「别动来动去」，不是「别给人读完的时间」。
 *
 *          进度条那一端另行处理：它表达的是「还剩多久」，属于信息而非装饰，故在那两个块里
 *          显式把时长恢复回来（见 `styles.css` 的 `.toast-bar`）。两处时长同取 `--toast-ms`，
 *          故走完的那一刻与计时到点是同一刻。
 *
 *          **指针悬停与键盘聚焦都暂停**，且暂停的是两者：`setTimeout` 按剩余时间重开，
 *          进度条 `animation-play-state: paused`。长回执（插件页那几条要说清依赖装成了没有）
 *          正是在使用者盯着读的时候最不该被收走。聚焦那一路不可省 —— 只认鼠标的话，
 *          键盘走到关闭钮上时条子会在手底下消失。
 */
import { onMounted, onUnmounted, ref } from "vue"
import { ICONS } from "../icons.js"
import { runToastAction } from "../toast.js"
import type { Toast } from "../toast.js"
import AppIcon from "./AppIcon.vue"

const props = defineProps<{
  /** 这一条回执 */
  toast: Toast
}>()

const emit = defineEmits<{
  /** 该收起了：计时到点，或使用者点了关闭 */
  done: []
}>()

/** 是否暂停中；同时驱动进度条的 `animation-play-state` */
const paused = ref(false)

/** 计时器句柄 */
let timer: ReturnType<typeof setTimeout> | undefined

/** 本轮计时开始的时刻 */
let startedAt = 0

/** 还剩多少毫秒。暂停时按已走的那段扣减，故续上之后总时长仍是 `toast.ms` */
let left = props.toast.ms

/** 开一轮计时 */
function start(): void {
  startedAt = Date.now()
  timer = setTimeout(() => emit("done"), left)
}

/** 停表。暂停与卸载两处都要 */
function stop(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

/** 暂停：停表并记下还剩多少 */
function pause(): void {
  if (paused.value) return
  stop()
  left = Math.max(0, left - (Date.now() - startedAt))
  paused.value = true
}

/** 续上：按剩余时间重开一轮 */
function resume(): void {
  if (!paused.value) return
  paused.value = false
  start()
}

onMounted(start)
onUnmounted(stop)
</script>

<template>
  <!--
    `--toast-ms` 从这里下去：进度条的时长由这一条回执的停留时长定（见 toast.ts 的
    `toastDurationOf`），而样式表无从知道那个数。
  -->
  <div
    class="toast"
    data-part="toast"
    :class="{ paused }"
    :style="{ '--toast-ms': `${toast.ms}ms` }"
    @mouseenter="pause"
    @mouseleave="resume"
    @focusin="pause"
    @focusout="resume"
  >
    <AppIcon class="toast-ico" :path="ICONS.check" />
    <p class="toast-text">{{ toast.text }}</p>
    <button v-if="toast.action" class="toast-act" type="button" @click="void runToastAction(toast.id)">
      {{ toast.action }}
    </button>
    <!--
      关闭钮一直在场，不只在悬停时出现：读完就想收走是常事，而一枚要先找才出现的钮
      等于没有。它同时是「暂停」的键盘入口 —— Tab 到它上面，上方的 `focusin` 即停表。
    -->
    <button class="icon toast-x" type="button" aria-label="关闭提示" @click="emit('done')">✕</button>
    <span class="toast-bar" aria-hidden="true" />
  </div>
</template>
