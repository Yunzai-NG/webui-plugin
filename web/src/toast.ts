/**
 * 模块职责：全站唯一一处成功回执的状态与提示入口
 * 依赖方向：只依赖 vue 的响应式；不认识任何视图
 * 生命周期：模块级单例，随页面存活
 * 注意事项：**只走成功回执，错误仍留在页内横幅里**（`.banner`）。两者的寿命本就不同：回执说的是
 *          「刚才那下成了」，看过即可丢；错误要留到使用者改掉它，自己消失的错误等于没报。
 *
 *          状态放模块而非组件：`App.vue` 只挂一个 `ToastHost`，任何深度的组件都能提示 —— 包括
 *          开在模态里的配置表单。谁用谁挂一个则同屏会摆出好几摞，而后挂的未必压得住先挂的。
 *
 *          **停留时长按文案长度算**（{@link toastDurationOf}）而非一律 2.6 秒：插件页那几条
 *          回执要说「依赖装成了没有、下一步该做什么」，一两百字按固定时长会在读完之前收走。
 *          再加上指针悬停暂停与一枚关闭钮（见 `ToastItem.vue`），长回执才不至于一闪而过。
 *
 *          **同文案不叠**：重复提示换掉原先那条（新 `id`，于是计时重新开始）。连点两下保存
 *          会得到两条一字不差的回执，而那并不表示发生了两件事。
 *
 *          **同时在场的几条错开到点**（{@link TOAST_STAGGER_MS}）：一次操作连提几条等长文案时，
 *          一摞条子会齐齐消失，读起来像界面闪了一下。错开之后是一条一条地收。
 */
import { ref } from "vue"

/** 一条回执 */
export interface Toast {
  /** 自增标识，供 `:key` 与手动关闭 */
  id: number
  /** 文案 */
  text: string
  /** 停留毫秒数，以 {@link toastDurationOf} 为底、再为错开让位；进度条的时长同取这个数 */
  ms: number
  /** 预计到点的时刻，只用来给后来的条子算错开间隔 */
  dueAt: number
}

/** 同时在场的回执上限，超出时丢最旧的那条 */
export const TOAST_MAX = 3

/** 相邻两条到点的最小间隔 */
export const TOAST_STAGGER_MS = 420

/** 最短停留：短回执（「已保存 xxx」）取这一档 */
export const TOAST_MIN_MS = 2600

/** 最长停留：再长的文案也不该把条子钉在页面顶上 */
export const TOAST_MAX_MS = 14_000

/** 每个字符折算的毫秒数，按中文的读速估 */
const MS_PER_CHAR = 90

/** 当前在场的回执，最新的在最后 */
export const toasts = ref<Toast[]>([])

/** 回执标识的自增源 */
let seq = 0

/**
 * 按文案长度算停留时长
 *
 * 纯函数，故有用例钉着两端的夹取 —— 算错不会报错，只会表现为「提示还没读完就没了」。
 * @param text 文案
 * @returns 停留毫秒数，夹在 {@link TOAST_MIN_MS} 与 {@link TOAST_MAX_MS} 之间
 */
export function toastDurationOf(text: string): number {
  const want = text.length * MS_PER_CHAR
  return Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, want))
}

/**
 * 提示一条成功回执
 *
 * 空串（或只有空白）不提示：调用方常把「清掉上一条」写成传空串，那不该弹出一个空条子。
 * @param text 文案
 */
export function showToast(text: string): void {
  const trimmed = text.trim()
  if (trimmed === "") return
  seq += 1
  // 同文案的旧条子先去掉，再把新的接到末尾：换了 `id`，`ToastItem` 随之重挂，计时从头开始
  const rest = toasts.value.filter(one => one.text !== trimmed)
  // 留下的条子再加这一条正好满员；满了就是丢最旧的那条
  const kept = rest.slice(1 - TOAST_MAX)
  const now = Date.now()

  // 到点时刻挨个躲开在场各条：按到点先后升序走，每次只往后挪，故走完与谁都隔着一个错开间隔。
  // 只在撞上时才挪，不强行按加入次序排队 —— 否则紧跟一条长回执之后的「已复制值」要陪着站十几秒
  let dueAt = now + toastDurationOf(trimmed)
  for (const one of [...kept].sort((a, b) => a.dueAt - b.dueAt)) {
    if (Math.abs(one.dueAt - dueAt) < TOAST_STAGGER_MS) dueAt = one.dueAt + TOAST_STAGGER_MS
  }

  toasts.value = [...kept, { id: seq, text: trimmed, ms: dueAt - now, dueAt }]
}

/**
 * 收起一条回执
 *
 * 计时到点与点关闭钮都走这里，故 `ToastHost` 只需把 `done` 接到这一个函数上。
 * @param id 回执标识
 */
export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter(one => one.id !== id)
}
