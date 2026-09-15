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
 *          暂存起来、被丢掉，还是整个动作作废。此时 Esc 与点遮罩都不该等同于「取消」：使用者以为
 *          自己关掉了一个可有可无的提示，实际上是撤销了一次更新。故那一类不给关闭途径，只给几个
 *          明确的选项与一个倒计时 —— 倒计时到点按 `timeoutOk` 结算，人走开了动作也能自己走完。
 *
 *          **答案是三值而非布尔**（`ok` / `cancel` / `alt`）：那个「有本地改动」的提问本就有三条路，
 *          而不是两条。`askConfirm` 仍返回 `Promise<boolean>` 供绝大多数只有两条路的提问使用，
 *          要第三条的用 `askConfirm3`。
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
  /**
   * 第三个选项的文案，缺省不给第三个按钮
   *
   * 存在的理由是**有些分支真的有三条路**：更新插件撞上本地改动时，「暂存」与「取消」
   * 之外还有「丢掉那些改动直接更新」—— 少了它，明知那几个文件是垃圾的人只能先去
   * 命令行 `git checkout .` 再回来点一次。两条路的框把第三种意图挤成了「自己想办法」。
   *
   * 它一律取 `danger` 形制并落在最左：这一类第三选项都是不可撤销的那一个。
   */
  altText?: string
}

/** 一次确认的答复 */
export type ConfirmAnswer = "ok" | "cancel" | "alt"

/** 当前待答复的请求；无对话框在场时为 undefined */
export const pending = ref<ConfirmRequest | undefined>(undefined)

/** 当前请求的结算函数 */
let settleCurrent: ((answer: ConfirmAnswer) => void) | undefined

/**
 * 发起一次确认
 *
 * 返回 `Promise<boolean>` 而非三值：绝大多数提问只有两条路，若让它们都去判断一个
 * 三值枚举，每个调用点都要写一次「`=== "ok"`」。要第三条路的用 {@link askConfirm3}。
 * @param request 请求内容
 * @returns 使用者是否点了确认
 */
export async function askConfirm(request: ConfirmRequest): Promise<boolean> {
  return (await askConfirm3(request)) === "ok"
}

/**
 * 发起一次三选确认
 *
 * 与 {@link askConfirm} 同一个对话框，只是把答案原样交回。给了 `altText` 才会出现
 * 第三个按钮，故不传它时本函数与 `askConfirm` 等价。
 * @param request 请求内容
 * @returns 使用者选了哪一个
 */
export function askConfirm3(request: ConfirmRequest): Promise<ConfirmAnswer> {
  // 旧提问按「取消」结算：默认取消而非确认，是因为这里的提问一律关乎破坏性操作
  settleCurrent?.("cancel")
  pending.value = request
  return new Promise<ConfirmAnswer>(resolve => {
    settleCurrent = resolve
  })
}

/**
 * 结算当前提问
 *
 * 由对话框组件调用。先清状态再 resolve：resolve 会同步唤起提问方的后续代码，
 * 那段代码可能立刻再问一次，此时 `pending` 必须已经是空的。
 * @param answer 使用者选了哪一个
 */
export function settleConfirm(answer: ConfirmAnswer): void {
  const resolve = settleCurrent
  settleCurrent = undefined
  pending.value = undefined
  resolve?.(answer)
}
