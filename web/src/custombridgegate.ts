/**
 * 模块职责：自定义页面数据桥的闸门判定 —— 一条请求是不理、拒掉、还是代取哪个地址
 * 依赖方向：不依赖任何东西。**尤其不 import api**（见下）
 * 生命周期：纯函数，无状态
 * 注意事项：与 `custombridge.ts` 分成两个文件只为一件事：能测。用例跑在 node 环境
 *          （无 jsdom，见 vitest.config.ts），而 `api.ts` **模块级**就读 `localStorage`，
 *          在 node 下一 import 即抛 —— 判定逻辑与它同处一个文件的话整个文件都测不到。
 *          放行与拒绝的边界正是这条桥唯一要紧的地方，非有用例钉住不可。
 *
 *          **白名单是路径的全集，不是前缀集。** 用前缀匹配的话 `config` 会连带放行
 *          `config/yunzai`，而**内核的 `GET config/:name` 刻意不脱敏**（见内核 api.ts 的注释），
 *          返回体里带着面板令牌与各适配器的连接密钥。插件页面拿到那些等于拿到整台机器。
 *          故配置一律不进白名单。
 *
 *          **只放 GET。** 写操作没有「读得到就写得动」的理由，且内核的写路径上挂着
 *          只读模式与操作日志。
 */

/** 允许插件页面读取的接口路径全集，相对 `/api` */
const ALLOWED = new Set([
  "overview",
  "system",
  "plugins",
  "commands",
  "tasks",
  "middlewares",
  "renderers",
  "adapters",
  "accounts",
  "server"
])

/** 消息类型标识，避免与页面自己的 postMessage 相混 */
export const BRIDGE_KIND = "yunzai-ng.custom"

/** 自建接口的前缀，与服务端 `custompage.ts` 拼的那条一致 */
const SELF_SCOPE = "/plugin/webui/custom"

/**
 * 自建接口的路径是否可用
 *
 * 与服务端 `isSafeRoutePath` 同一套字符集：注册时过不了那道校验的路径这里也取不到，
 * 提前挡掉能让错误说的是「路径不合法」而不是一个 404。`..` 单独拒 —— 允许它的话
 * 页面可以用 `../../` 走出自己的前缀，去点面板的任何接口。
 * @param path 页面自报的接口路径
 * @returns 合法则为 true
 */
function isSafeSelfPath(path: string): boolean {
  if (path === "" || path.includes("..")) return false
  return /^[A-Za-z0-9._/-]+$/.test(path)
}

/**
 * 把页面自报的路径归一成注册时那个样子
 *
 * 服务端 `registerApi` 宽容地剥掉前导斜杠（见 src/custompage.ts），故插件写
 * `registerApi("/stats")` 也注册得上，落在 `…/api/stats`。页面若照同样的写法取，
 * 不剥就会拼出 `…/api//stats` 打不中。两边用同一套剥法，`/stats` 与 `stats` 同指一处。
 * @param path 页面自报的接口路径
 * @returns 去掉前导斜杠后的路径
 */
function normalizeSelfPath(path: string): string {
  return path.replace(/^\/+/, "")
}

/** iframe 发来的取数请求 */
export interface BridgeRequest {
  /** 消息类型标识，不是 `BRIDGE_KIND` 的一概不理 */
  kind: string
  /** 请求标识，原样回传，页面据它把应答对上自己那次请求 */
  id?: unknown
  /** 接口路径；`self` 为真时相对本插件的接口前缀，否则须在白名单内 */
  path?: unknown
  /** 取本插件自己 `registerApi` 注册的接口，而非白名单内的面板接口 */
  self?: unknown
}

/** 一条请求该怎么处理 */
export type BridgeVerdict =
  /** 与本桥无关，不理它（不是拒绝：回一条错误会打扰页面自己的 postMessage） */
  | { readonly act: "ignore" }
  /** 拒掉，把 `error` 回给页面 */
  | { readonly act: "deny"; readonly error: string }
  /** 代取面板接口，`path` 相对 `/api` */
  | { readonly act: "panel"; readonly path: string }
  /** 代取本插件自建接口，`url` 是绝对路径 */
  | { readonly act: "self"; readonly url: string }

/**
 * 读取白名单，供页面自我说明与用例用
 * @returns 允许的路径，按声明顺序
 */
export function allowedPaths(): readonly string[] {
  return [...ALLOWED]
}

/**
 * 判一条请求该怎么处理
 * @param body 页面发来的消息体，未经任何校验
 * @param plugin 当前页面所属的插件标识，取不到时为空串
 * @returns 处置方式
 */
export function judgeRequest(body: unknown, plugin: string): BridgeVerdict {
  if (body === null || typeof body !== "object") return { act: "ignore" }
  const req = body as BridgeRequest
  if (req.kind !== BRIDGE_KIND) return { act: "ignore" }

  const path = typeof req.path === "string" ? req.path : ""
  const shown = path === "" ? "(空)" : path

  if (req.self === true) {
    // 插件标识由外壳给，此处为空说明清单还没回来，不是页面写错了 —— 说清可重试
    if (plugin === "") return { act: "deny", error: "尚未确定当前页面所属的插件，稍后再试" }
    const clean = normalizeSelfPath(path)
    if (!isSafeSelfPath(clean)) return { act: "deny", error: `接口路径 ${shown} 不合法` }
    return { act: "self", url: `${SELF_SCOPE}/${plugin}/api/${clean}` }
  }

  // 说清「不在白名单」而非笼统的「拒绝」：插件作者据此知道该换哪个路径，
  // 而不是去怀疑自己的令牌或网络
  if (!ALLOWED.has(path)) return { act: "deny", error: `接口 ${shown} 不在只读白名单内` }
  return { act: "panel", path }
}
