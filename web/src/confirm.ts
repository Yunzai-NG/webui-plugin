/**
 * 模块职责：全站唯一一处确认对话框的状态与提问入口
 * 依赖方向：只依赖 vue 的响应式；不认识任何视图
 * 生命周期：模块级单例，随页面存活
 * 注意事项：提问方拿到 `Promise<boolean>`，与浏览器 `confirm()` 同形，故
 *          `if (!(await askConfirm({…}))) return` 保持守卫子句的形状。
 *
 *          状态放模块而非组件：`App.vue` 只挂一个实例，任何深度的组件都能提问。谁提问谁挂一个
 *          则同屏可能出现两个遮罩，而后挂的未必压得住先挂的。
 *
 *          **同时只允许一个提问在场**，新提问到来时旧提问按「取消」结算 —— 让两个对话框排队，
 *          第二个会在使用者已离开该页面之后才弹出，届时他无从判断这是在问什么。
 *
 *          **另有一类「必须当场答」的提问**（`dismissible: false` + `countdown`）：它出现在一个
 *          已经开始、且停不下来的动作中途 —— 更新插件时发现目录里有改动，答案决定那些改动是被
 *          暂存起来还是整个动作作废。此时 Esc 与点遮罩都不该等同于「取消」：使用者以为自己关掉了
 *          一个可有可无的提示，实际上是撤销了一次更新。故那一类不给关闭途径，只给两个明确的选项
 *          与一个倒计时 —— 倒计时到点按 `timeoutOk` 结算，人走开了动作也能自己走完。
 */
import { ref } from "vue"

/** 一次确认请求 */
export interface ConfirmRequest {
  /** 标题：一句话说清要做什么 */
  title: string
  /** 正文：说清后果，尤其是不可撤销的部分 */
  body: string
  /** 确认按钮的文案，缺省「确认」 */
  okText?: string
  /** 取消按钮的文案，缺省「取消」 */
  cancelText?: string
  /**
   * 是否为破坏性操作
   *
   * 为真时确认按钮取 `danger` 形制。删除、卸载、恢复默认值都属此类。
   */
  danger?: boolean
  /** 逐条列出的补充说明，用于「这些内容会一并消失」一类的枚举 */
  details?: readonly string[]
  /**
   * 能否用 Esc 或点遮罩关掉，缺省可以
   *
   * 置假仅用于「动作已经开始、必须当场答」的提问：那时关闭这个框不等于「什么都没发生」，
   * 而等于替使用者选了一个他没看清的分支。
   */
  dismissible?: boolean
  /**
   * 倒计时秒数，缺省不倒计时
   *
   * 到点按 {@link timeoutOk} 自动结算。存在的理由是**这类提问卡在一个进行中的动作里** ——
   * 人离开了，那个动作不该无限期挂着。
   */
  countdown?: number
  /** 倒计时到点时按哪一边结算，缺省确认 */
  timeoutOk?: boolean
}

/** 当前待答复的请求；无对话框在场时为 undefined */
export const pending = ref<ConfirmRequest | undefined>(undefined)

/** 当前请求的结算函数 */
let settleCurrent: ((ok: boolean) => void) | undefined

/**
 * 发起一次确认
 * @param request 请求内容
 * @returns 使用者是否点了确认
 */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  // 旧提问按「取消」结算：默认取消而非确认，是因为这里的提问一律关乎破坏性操作
  settleCurrent?.(false)
  pending.value = request
  return new Promise<boolean>(resolve => {
    settleCurrent = resolve
  })
}

/**
 * 结算当前提问
 *
 * 由对话框组件调用。先清状态再 resolve：resolve 会同步唤起提问方的后续代码，
 * 那段代码可能立刻再问一次，此时 `pending` 必须已经是空的。
 * @param ok 是否确认
 */
export function settleConfirm(ok: boolean): void {
  const resolve = settleCurrent
  settleCurrent = undefined
  pending.value = undefined
  resolve?.(ok)
}
