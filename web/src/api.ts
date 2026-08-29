/**
 * 模块职责：面板 API 客户端 —— 请求封装、令牌携带、错误归一化、日志 WebSocket
 * 依赖方向：仅依赖浏览器 API 与 `@yunzai-ng/types`；不感知任何视图
 * 生命周期：模块级单例，令牌保存于 localStorage
 * 注意事项：以下三条与内核 `server/auth.ts` 严格对应，修改前应先阅读该文件：
 *          1) **令牌仅经请求头传递**（`Authorization: Bearer`），不得置于查询串 ——
 *             查询串会进入 access log、浏览器历史与 Referer，且服务端不读该位置。
 *          2) **WebSocket 的令牌经子协议传递** `["yunzai", token]`。浏览器的 WebSocket
 *             构造函数无法设置请求头，子协议是唯一的合法通道，且不会被自动附带，故不引入 CSRF。
 *          3) **写请求的 Content-Type 必须为 application/json**。服务端将表单类型的写请求
 *             一律以 415 拒绝，该行为构成其跨站请求伪造防线。
 *
 *          400 响应中的 `issues` 数组须原样传递给调用方（见 `ApiError.issues`），
 *          配置表单据它把错误标到具体字段。
 */
import type { SchemaIssue } from "@yunzai-ng/types"

/** 所有端点的前缀，与内核的 `API_SCOPE` 一致 */
const API_SCOPE = "/api"

/** localStorage 中保存令牌的键 */
const TOKEN_KEY = "yunzai-ng.token"

/** WebSocket 子协议的第一个标识，与内核 `auth.ts` 的 `WS_PROTOCOL` 一致 */
const WS_PROTOCOL = "yunzai"

/** 一次失败的 API 调用 */
export class ApiError extends Error {
  /** HTTP 状态码；网络层失败时为 0 */
  readonly status: number
  /** 逐字段的校验错误，仅当状态码为 400 且服务端提供时存在 */
  readonly issues: readonly SchemaIssue[]

  /**
   * @param status 状态码
   * @param message 面向用户的原因说明
   * @param issues 逐字段错误
   */
  constructor(status: number, message: string, issues: readonly SchemaIssue[] = []) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.issues = issues
  }

  /** 是否属于令牌缺失或不匹配一类，调用方据此弹出令牌输入框而非展示错误横幅 */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
}

/** 当前令牌，空串表示未设置（本机访问且服务端亦未设置令牌时属正常状态） */
let token = localStorage.getItem(TOKEN_KEY) ?? ""

/**
 * 读取当前令牌
 * @returns 令牌，未设置时为空串
 */
export function getToken(): string {
  return token
}

/**
 * 设置令牌
 *
 * 保存于 localStorage 而非 sessionStorage：面板属长期使用的本机工具，每开一个标签页
 * 都要重填令牌会显著妨碍使用。
 * @param value 令牌；空串表示清除
 */
export function setToken(value: string): void {
  token = value.trim()
  if (token === "") localStorage.removeItem(TOKEN_KEY)
  else localStorage.setItem(TOKEN_KEY, token)
}

/**
 * 构造鉴权请求头
 * @returns 请求头对象
 */
function authHeaders(): Record<string, string> {
  return token === "" ? {} : { Authorization: `Bearer ${token}` }
}

/**
 * 将一个失败响应归一化为 ApiError
 * @param res 响应
 * @returns 归一化后的错误
 */
async function toError(res: Response): Promise<ApiError> {
  let message = `请求失败（HTTP ${res.status}）`
  let issues: SchemaIssue[] = []
  try {
    const body = (await res.json()) as { error?: unknown; issues?: unknown }
    if (typeof body.error === "string" && body.error !== "") message = body.error
    if (Array.isArray(body.issues)) issues = body.issues as SchemaIssue[]
  } catch {
    // 响应体非 JSON，最常见者为反向代理返回的 HTML 错误页。
    // 保留上面含状态码的兜底文案，它至少能指明该错误并非来自内核
  }
  return new ApiError(res.status, message, issues)
}

/**
 * 发起一次 API 请求
 * @param method HTTP 方法
 * @param path 相对 `/api` 的路径，不含前导斜杠
 * @param body 请求体，将被 JSON 序列化
 * @returns 解析后的响应体；状态码为 204 时为 undefined
 * @throws ApiError 状态码非 2xx，或网络层失败时
 */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_SCOPE}/${path}`, {
      method,
      headers: {
        ...authHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  } catch (err) {
    // fetch 仅在网络层失败时 reject，此处几乎均为内核已停止运行 ——
    // 说清这一点远比抛一个 TypeError: Failed to fetch 有用
    throw new ApiError(0, `无法连接内核：${err instanceof Error ? err.message : String(err)}。内核可能已停止运行`)
  }

  if (!res.ok) throw await toError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * GET
 * @param path 路径
 * @returns 响应体
 */
export const get = <T>(path: string): Promise<T> => request<T>("GET", path)

/**
 * 带鉴权的请求，路径不拼 `/api` 前缀
 *
 * **为面板插件而设**：插件的 node 侧、面板的清单端点与面板插件的配置端点都在
 * `/plugin/` 之下，不在 `/api` 里，而令牌与错误归一化那几条与 `request()` 一致。
 * @param method HTTP 方法
 * @param url 绝对路径，须以 `/` 开头
 * @param body 请求体，将被 JSON 序列化；省略即不带体
 * @returns 响应体；状态码为 204 时为 undefined
 * @throws ApiError 状态码非 2xx，或网络层失败时
 */
export async function requestAt<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...authHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  } catch (err) {
    throw new ApiError(0, `无法连接内核：${err instanceof Error ? err.message : String(err)}。内核可能已停止运行`)
  }

  if (!res.ok) throw await toError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * 带鉴权的 GET，路径不拼 `/api` 前缀
 *
 * 另开一族函数而不给 `get()` 加「是否绝对路径」的开关：这两类路径在写代码时就已确定，
 * 不是运行时才知道的事。
 * @param url 绝对路径，须以 `/` 开头
 * @returns 响应体
 */
export const getAt = <T>(url: string): Promise<T> => requestAt<T>("GET", url)

/**
 * 带鉴权的 PUT，路径不拼 `/api` 前缀
 * @param url 绝对路径
 * @param body 请求体
 * @returns 响应体
 */
export const putAt = <T>(url: string, body: unknown): Promise<T> => requestAt<T>("PUT", url, body)

/**
 * 带鉴权的 POST，路径不拼 `/api` 前缀
 * @param url 绝对路径
 * @param body 请求体，可省
 * @returns 响应体
 */
export const postAt = <T>(url: string, body?: unknown): Promise<T> => requestAt<T>("POST", url, body)

/**
 * 带鉴权的 DELETE，路径不拼 `/api` 前缀
 *
 * 面板插件商店的「删除」用它 —— 那条路由在 `/plugin/webui/panelstore/:name`。
 * @param url 绝对路径
 * @returns 响应体
 */
export const delAt = <T>(url: string): Promise<T> => requestAt<T>("DELETE", url)

/**
 * POST
 * @param path 路径
 * @param body 请求体
 * @returns 响应体
 */
export const post = <T>(path: string, body?: unknown): Promise<T> => request<T>("POST", path, body)

/**
 * PATCH
 * @param path 路径
 * @param body 请求体
 * @returns 响应体
 */
export const patch = <T>(path: string, body: unknown): Promise<T> => request<T>("PATCH", path, body)

/**
 * PUT
 * @param path 路径
 * @param body 请求体
 * @returns 响应体
 */
export const put = <T>(path: string, body: unknown): Promise<T> => request<T>("PUT", path, body)

/**
 * DELETE
 * @param path 路径
 * @returns 响应体
 */
export const del = <T>(path: string): Promise<T> => request<T>("DELETE", path)

/**
 * 建立一条带鉴权的 WebSocket 连接
 *
 * 令牌经子协议而非查询串传递，见文件头第 2 条。未设置令牌时不传子协议 ——
 * 若传入仅含 `"yunzai"` 而无令牌的数组，服务端将视其为携带了一个空令牌。
 * @param path 相对 `/api` 的路径，可含查询串
 * @returns WebSocket 实例
 */
export function openSocket(path: string): WebSocket {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:"
  const url = `${scheme}//${location.host}${API_SCOPE}/${path}`
  return token === "" ? new WebSocket(url) : new WebSocket(url, [WS_PROTOCOL, token])
}
