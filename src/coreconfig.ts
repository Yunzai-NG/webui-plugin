/**
 * 模块职责：读内核配置里 webui 用得到的两项 —— 镜像前缀与只读开关
 * 依赖方向：依赖 node 内置模块与内核导出的 `CORE_CONFIG_NAME` / `parseYaml`；不认识 Vue
 * 生命周期：无状态，每次调用都重读文件
 * 注意事项：两项都读内核的配置文件而非自己声明。镜像前缀（`market.mirror`）使用者已经填过，再要一遍
 *          必有人忘，忘的表现是「面板商店连不上，而插件市场是好的」；只读开关（`server.readonly`）则
 *          因内核的 `requireWritable()` 只拦 `/api` 之下的请求，管不到本插件 scope 里的写路由。
 *
 *          `CORE_CONFIG_NAME` 与 `parseYaml` 都是公开符号，故这不是钻内核内部路径。代价照记：内核若
 *          挪动这两个键，此处会静默退回默认值。
 *
 *          `readonly` 取不到时取 false 而非 true：常态是使用者从未开过只读模式，按 true 处置会让一个
 *          正常实例全线拒写。只读是防手滑而非防入侵，那些路由照旧要令牌。
 *
 *          每次调用都重读 —— 这两项运行期可改（配置页就能改只读开关），读一次存起来的表现是「关了只读
 *          模式，商店还是拒写，重启才好」。
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** 取不到配置时的镜像前缀：直连 */
const NO_MIRROR = ""

/** 内核配置里本模块要读的两项 */
export interface CoreSettings {
  /**
   * 镜像前缀，空串表示直连
   *
   * 语义与内核的 `market.mirror` 完全一致（仅对三个 GitHub 主机生效），
   * 故取到之后交给内核导出的 `applyMirror` 处理，不在此处自行拼接。
   */
  readonly mirror: string
  /** 面板是否处于只读模式 */
  readonly readonly: boolean
}

/** 本模块要的那点外部能力 */
export interface CoreConfigDeps {
  /** 内核配置目录，取自 `ctx.app.paths.config` */
  readonly configDir: string
  /** 内核配置名，取自内核导出的 `CORE_CONFIG_NAME`；由调用方传入以免本模块 import 内核 */
  readonly configName: string
  /**
   * 解析 yaml，由调用方传入内核导出的 `parseYaml`
   *
   * 不在此处 import 内核：本模块的取值规则要由用例钉住，而一旦 import 了内核的运行时，
   * 这一段就只能靠端到端核对来验。
   * @param text 文件内容
   * @returns 解析结果
   */
  readonly parse: (text: string) => unknown
  /**
   * 记一条调试信息
   * @param msg 内容
   */
  readonly debug: (msg: string) => void
}

/**
 * 是不是一个普通对象（数组与 null 均不算）
 * @param value 待判定的值
 * @returns 是否为对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 从一份已解析的内核配置里取出两项
 *
 * 纯函数，与读盘分开：文件读不动、yaml 写坏了、键缺失、键的类型不对 —— 四种情形的
 * 退回值都要能立断言，而其中三种在真实文件上难以复现。
 * @param doc 已解析的配置文档
 * @returns 两项设置
 */
export function settingsFrom(doc: unknown): CoreSettings {
  if (!isRecord(doc)) return { mirror: NO_MIRROR, readonly: false }
  const market = isRecord(doc.market) ? doc.market : undefined
  const server = isRecord(doc.server) ? doc.server : undefined
  const mirror = typeof market?.mirror === "string" ? market.mirror.trim() : NO_MIRROR
  // 只有确凿的 true 才算开着；内核的 `requireWritable()` 也是这么判的
  return { mirror, readonly: server?.readonly === true }
}

/**
 * 读内核配置里的两项
 *
 * 不抛错：调用点是「使用者点了安装」与「使用者点了保存」，那两处该给出的是动作本身的结果，
 * 不是一句与他的动作无关的「读配置失败」。
 * @param deps 外部能力
 * @returns 两项设置；任何一步不成时给出默认值（直连、非只读）
 */
export async function readCoreSettings(deps: CoreConfigDeps): Promise<CoreSettings> {
  const file = join(deps.configDir, `${deps.configName}.yaml`)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    deps.debug(`读不到内核配置 ${file}，面板商店按直连处置，只读模式按未开启处置`)
    return { mirror: NO_MIRROR, readonly: false }
  }
  try {
    return settingsFrom(deps.parse(text))
  } catch (err) {
    deps.debug(`内核配置 ${file} 解析失败：${err instanceof Error ? err.message : String(err)}`)
    return { mirror: NO_MIRROR, readonly: false }
  }
}
