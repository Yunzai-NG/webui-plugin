/**
 * 模块职责：自定义页面数据桥 —— 只读取数与显式授权的本插件配置编辑
 * 依赖方向：依赖 api（借它的令牌与错误归一化）与 custombridgegate（判定）；不认识任何视图
 * 生命周期：由 CustomPageView 挂载与拆除，随页面切换
 * 注意事项：**iframe 的 sandbox 不给 `allow-same-origin`**（见 CustomPageView.vue），故 iframe 内的脚本
 *          与面板不同源：它读不到 localStorage 里的令牌，也拿不到 `window.parent` 的任何属性。
 *          这条桥是它取数的唯一通道，本模块就是那道闸。若哪天给 iframe 加回 `allow-same-origin`，
 *          整套白名单立刻形同虚设 —— 页面脚本可以直接读令牌自己发请求。
 *
 *          放行与拒绝的规则不在此处而在 `custombridgegate.ts`：那边不 import api，故能在 node 环境
 *          下立用例（`api.ts` 模块级就读 localStorage）。本模块只剩收发，无判断可测。
 *
 *          除白名单外还代取**页面自己插件注册的接口**（`self: true`）。这条不可省：`registerApi` 注册的
 *          路由要令牌，而 iframe 内没有令牌，页面便取不到自己备好的数据 —— 等于注册了个自己用不了的接口。
 *          **插件标识由外壳按当前页给出，不收 iframe 自报的**，否则一个插件的页面可以填别人的名字，
 *          去读另一家插件的接口。
 *
 *          应答一律回到 `event.source`，且**带上 `id` 原样回传** —— iframe 里可能有多个组件同时取数，
 *          没有 id 就无从知道哪条应答对应哪次请求。
 *
 *          `targetOrigin` 用 `"*"` 而非具体源：sandbox 且无 allow-same-origin 的 iframe 其源是不透明的
 *          （序列化为 `"null"`），指定任何具体值都投递不到。应答内容仅限白名单内的只读数据，
 *          且只回给 `event.source` 这一个窗口，故不构成额外泄露。
 */
import { get, getAt, request, ApiError } from "./api.js"
import { judgeRequest, BRIDGE_KIND, type BridgeRequest } from "./custombridgegate.js"

export { allowedPaths } from "./custombridgegate.js"

/** 回给 iframe 的应答 */
interface BridgeReply {
  kind: string
  id: unknown
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * 装上数据桥
 *
 * 只处理来自 `frame` 的消息：同一时刻面板上可能还有别的 iframe（面板插件商店的预览），
 * 不认窗口就等于让任何 iframe 都能借这条桥取数。
 * @param frame 目标 iframe 元素的取值函数，元素在 `onMounted` 后才存在
 * @param plugin 当前页面所属的插件标识取值函数，`self` 请求据它拼前缀；取不到则拒掉 `self`
 * @param configurable 当前服务端页面描述符是否开启配置编辑
 * @returns 拆除函数
 */
export function attachBridge(frame: () => HTMLIFrameElement | null, plugin: () => string, configurable: () => boolean = () => false): () => void {
  let active = true
  /**
   * 处理一条消息
   * @param event 消息事件
   */
  const onMessage = (event: MessageEvent): void => {
    const target = frame()
    if (target === null || event.source !== target.contentWindow) return

    const owner = plugin()
    const source = event.source as Window
    const verdict = judgeRequest(event.data, owner, configurable())
    if (verdict.act === "ignore") return

    const id = (event.data as BridgeRequest).id ?? null
    /**
     * 回一条应答
     * @param reply 除 kind 与 id 之外的内容
     */
    const send = (reply: Omit<BridgeReply, "kind" | "id">): void => {
      // 切换页面或拆除桥后，不把上一页（可能含配置）的结果交给新页面。
      if (!active || frame() !== target || plugin() !== owner || target.contentWindow !== source) return
      source.postMessage({ kind: BRIDGE_KIND, id, ...reply } satisfies BridgeReply, "*")
    }

    if (verdict.act === "deny") {
      send({ ok: false, error: verdict.error })
      return
    }

    const task = verdict.act === "config"
      ? request<unknown>(verdict.method, verdict.path, verdict.body)
      : verdict.act === "self" ? getAt<unknown>(verdict.url) : get<unknown>(verdict.path)
    void task.then(
      data => send({ ok: true, data }),
      (err: unknown) => send({ ok: false, error: err instanceof ApiError ? err.message : String(err) })
    )
  }

  window.addEventListener("message", onMessage)
  return () => {
    active = false
    window.removeEventListener("message", onMessage)
  }
}
