/**
 * 模块职责：共享刷新节拍 —— 一份定时器供全部面板插件组件共用
 * 依赖方向：无依赖，只用 setInterval / clearInterval
 * 生命周期：模块级单例；有订阅者时起表，最后一个退订时停表
 * 注意事项：**存在的理由是「不让插件各自 setInterval」**：各起一条表就是若干互不对齐的
 *          节拍，且组件里起的表谁都可能忘记清 —— 忘记了不报错，只是移除之后仍在发请求。
 *
 *          **没有订阅者时不留着表空转**，**回调里抛出的错不许打断其余订阅者**（逐个
 *          try/catch）。
 *
 *          **不与 `OverviewView.vue` 里那条 5 秒轮询合并**：那条拉共享快照，插件拉各自的
 *          端点，合并会把两者的失败路径缠在一起。
 */

/** 节拍间隔，与 `OverviewView.vue` 的轮询同为 5 秒：两处的数字看起来该是同时更新的 */
export const TICK_MS = 5000

/** 当前订阅者 */
const subscribers = new Set<() => void>()

/** 定时器句柄；undefined 表示表没在走 */
let timer: ReturnType<typeof setInterval> | undefined

/** 触发一轮，逐个隔离 */
function fire(): void {
  for (const fn of [...subscribers]) {
    try {
      fn()
    } catch (err) {
      // 订阅者多为 async 函数，同步抛出者少见；但一旦发生，
      // 不隔离就会让本轮剩下的订阅者收不到这一拍
      console.error("面板节拍的一个订阅者抛出了错误", err)
    }
  }
}

/**
 * 订阅节拍
 *
 * **不立即触发一次**：组件想要的首轮时机各不相同，故首轮取数由调用方自行发起。
 * @param fn 每拍执行一次；抛出的错会被记录并隔离
 * @returns 退订函数，重复调用无害
 */
export function onTick(fn: () => void): () => void {
  subscribers.add(fn)
  if (timer === undefined) timer = setInterval(fire, TICK_MS)

  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/**
 * 当前订阅者数量，供用例断言起表 / 停表
 * @returns 订阅者数量
 */
export function tickSubscriberCount(): number {
  return subscribers.size
}

/**
 * 表是否在走，供用例断言「最后一个退订之后没有表空转」
 * @returns 是否有活跃定时器
 */
export function tickRunning(): boolean {
  return timer !== undefined
}
