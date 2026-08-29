/**
 * 模块职责：路径选择的模块级状态 —— 一个「问一次、答一次」的通道
 * 依赖方向：无依赖，只有 Vue 的 ref
 * 生命周期：模块级单例，随页面存活
 * 注意事项：与 `confirm.ts` 同一形制，理由也相同：**同时只允许存在一个选择器** ——
 *          模态之上再叠一个模态，Esc 该关哪一个就成了要猜的事。
 *
 *          新的提问到来时先把上一个以「取消」结算，**绝不留下一个永不 resolve 的 Promise**：
 *          那会让调用方的 `await` 永久悬住，表现为「点了浏览没反应」，极难查。
 */
import { ref } from "vue"

/** 一次路径选择的请求 */
export interface PathRequest {
  /** 对话框标题，通常是字段名 */
  title: string
  /** 选目录还是选文件 */
  mode: "file" | "dir"
  /** 起始目录；为空时由内核决定（Windows 列盘符、其余列根目录） */
  start?: string
}

/** 当前待答的请求；无请求时 undefined */
export const pending = ref<PathRequest | undefined>(undefined)

/** 当前请求的结算函数 */
let settleCurrent: ((path: string | undefined) => void) | undefined

/**
 * 请使用者挑一个路径
 * @param request 请求内容
 * @returns 选中的绝对路径；取消时 undefined
 */
export function askPath(request: PathRequest): Promise<string | undefined> {
  settleCurrent?.(undefined)
  pending.value = request
  return new Promise<string | undefined>(resolve => {
    settleCurrent = resolve
  })
}

/**
 * 结算当前请求
 *
 * 对没有待答请求时的调用是空操作：原生 `<dialog>` 的 `close` 事件会在点了「选定」
 * 之后再触发一次，此处必须容得下那一次。
 * @param path 选中的路径；取消时 undefined
 */
export function settlePath(path: string | undefined): void {
  const resolve = settleCurrent
  settleCurrent = undefined
  pending.value = undefined
  resolve?.(path)
}
