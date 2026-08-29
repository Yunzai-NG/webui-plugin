/**
 * 模块职责：加载面板插件包的 node 侧入口 —— import 它、给一份受限上下文、失败只废掉那一个包
 * 依赖方向：只依赖 node 内置模块与本目录的 panelscan 类型；不 import 内核，也不认识 Vue
 * 生命周期：`setup()` 时逐个加载；卸载由内核回收 webui 注册的路由，故此处不必自己撤
 * 注意事项：node 侧入口是可选的 —— 绝大多数面板插件只画一个格子，不该被迫写两个文件。只有
 *          package.json 里声明了 `webuiPanel.server` 的包才走这一路。
 *
 *          给的是受限上下文而非内核的 `PluginContext`：只有 `route` / `logger` / `dataDir` / `dir` /
 *          `config` 五项，路由一律落在该包自己的前缀之下。给全套等于让面板插件包变成第二种内核插件。
 *
 *          逐个 try，一个坏包只废掉它自己：模块语法错、缺 `setup`、`setup` 抛错、`import` 到不存在的
 *          文件，任何一条抛到 webui 的 `setup()` 都会让整个面板打不开。
 *
 *          路由前缀与静态挂载的前缀刻意分开（`papi/` 对 `pp/`）：同处一个空间时，静态处理器与路由谁先
 *          匹配就成了实现细节，而错的那一侧表现为「这个接口稳定地返回 404」。
 *
 *          `import()` 绝对路径必须先转 file:// URL。Windows 上 `import("C:\\x\\y.js")` 会被当成裸包名
 *          （`C:` 像 scope 名），报「找不到模块」而非路径错。
 */
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { configKeyOf } from "./panelconfig.js"
import { PANEL_API_PREFIX, apiBaseOf, type PanelPackage } from "./panelscan.js"

/** 面板插件包 node 侧入口须导出的形状 */
export interface PanelServer {
  /**
   * 注册本包的 node 侧能力
   * @param ctx 受限上下文
   */
  setup(ctx: PanelServerContext): void | Promise<void>
}

/** 给面板插件包 node 侧入口的受限上下文 */
export interface PanelServerContext {
  /** 包名 */
  readonly name: string
  /** 包目录绝对路径；包自己的静态资源与配置文件都在这里 */
  readonly dir: string
  /** webui 的数据目录，包可在其下自建子目录存放数据 */
  readonly dataDir: string
  /** 日志器，前缀已带包名 */
  readonly logger: PanelServerLogger
  /**
   * 注册一条 GET 路由，落在本包自己的前缀之下
   * @param path 相对本包的路径，如 `hardware`
   * @param handler 处理函数，返回值即响应体
   */
  route(path: string, handler: () => unknown): void
  /**
   * 取本包当前的配置值
   *
   * **每次调用都读一次当前值，不要在 `setup` 里取一次存起来。** 使用者在面板上改了配置
   * 之后，webui 更新的是它那份缓存 —— 存下来的那个对象不会跟着变，表现为「改了配置，
   * 重启前一直不生效」。
   *
   * 值已按 package.json 里的 `webuiPanel.config` 填过默认值、查过类型，故 `config().port`
   * 若声明为 number 就一定是 number。**取值范围不保证**（见 `panelconfig.ts` 文件头），
   * 故仍要容得下一个手改进去的 0 或 99999。
   *
   * 没声明配置项的包拿到的是空对象。
   * @returns 当前配置值
   */
  config<T = Record<string, unknown>>(): T
}

/** 受限上下文里的日志器 */
export interface PanelServerLogger {
  /**
   * 记一条警告
   * @param msg 内容
   */
  warn(msg: string): void
  /**
   * 记一条错误
   * @param msg 内容
   */
  error(msg: string): void
  /**
   * 记一条调试信息
   * @param msg 内容
   */
  debug(msg: string): void
}

/** 加载 node 侧入口所需的外部能力 */
export interface ServerHost {
  /** webui 的数据目录 */
  readonly dataDir: string
  /** webui 的日志器 */
  readonly logger: PanelServerLogger
  /**
   * 注册路由，路径相对 webui 自己的 scope
   * @param method HTTP 方法
   * @param path 路径
   * @param handler 处理函数
   * @returns 注销句柄，本模块不使用
   */
  route(method: "GET", path: string, handler: () => unknown): unknown
  /**
   * 取某个包当前的配置值
   *
   * 由 webui 的 `PanelConfigStore` 提供。**同步**，理由见 `PanelServerContext.config`
   * 与 store 的文件头：包的采样函数不该为了读一项配置而变成 async。
   * @param key 包键，形如 `panels/hardware`
   * @returns 当前值；没声明配置的包为空对象
   */
  config(key: string): Record<string, unknown>
}

/**
 * 路由路径是否可安全拼进 URL
 *
 * 包自己给的路径同样不可信：一个 `../` 就能把它注册到别的包的前缀之下，而那不是
 * 目录穿越却是**路由穿越** —— 后果是一个包悄悄接管了另一个包的接口。只放行
 * 字母数字与 `._-/`，且不许出现 `..`。
 * @param path 相对路径
 * @returns 是否放行
 */
export function isSafeRoutePath(path: string): boolean {
  if (path === "" || path.includes("..")) return false
  return /^[A-Za-z0-9._/-]+$/.test(path)
}

/**
 * 校验一个 import 回来的模块是不是 node 侧入口该有的样子
 * @param mod 模块对象
 * @returns 通过时给出入口，否则给出一句面向使用者的原因
 */
export function checkPanelServer(mod: unknown): { ok: true; server: PanelServer } | { ok: false; reason: string } {
  const source = typeof mod === "object" && mod !== null ? (mod as { default?: unknown }).default : undefined
  const candidate = source ?? mod
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, reason: "node 侧入口须默认导出一个含 setup 的对象" }
  }
  const setup = (candidate as { setup?: unknown }).setup
  if (typeof setup !== "function") {
    return { ok: false, reason: "node 侧入口的默认导出缺少 setup 函数" }
  }
  return { ok: true, server: candidate as PanelServer }
}

/**
 * 加载一个包的 node 侧入口
 *
 * 返回是否加载成功，供调用方计数与用例断言。**不抛错**：理由见文件头。
 * @param host webui 侧能力
 * @param pkg 包
 * @returns 是否成功
 */
export async function loadPanelServer(host: ServerHost, pkg: PanelPackage): Promise<boolean> {
  if (pkg.serverEntry === undefined) return false

  const file = join(pkg.dir, pkg.serverEntry)
  let mod: unknown
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (err) {
    host.logger.error(
      `面板插件包 ${pkg.owner}/${pkg.name} 的 node 侧入口加载失败（${pkg.serverEntry}）：` +
        `${err instanceof Error ? err.message : String(err)}。` +
        `若它声明了依赖，须在 ${pkg.dir} 目录内执行包管理器安装`
    )
    return false
  }

  const checked = checkPanelServer(mod)
  if (!checked.ok) {
    host.logger.error(`面板插件包 ${pkg.owner}/${pkg.name} 的 node 侧入口形状不对：${checked.reason}`)
    return false
  }

  const base = apiBaseOf(pkg)
  const prefix = `/${PANEL_API_PREFIX}/${pkg.owner}/${pkg.name}`
  const label = `面板插件包 ${pkg.owner}/${pkg.name}`
  const ctx: PanelServerContext = {
    name: pkg.name,
    dir: pkg.dir,
    dataDir: host.dataDir,
    logger: {
      warn: msg => host.logger.warn(`${label}：${msg}`),
      error: msg => host.logger.error(`${label}：${msg}`),
      debug: msg => host.logger.debug(`${label}：${msg}`)
    },
    route: (path, handler) => {
      if (!isSafeRoutePath(path)) {
        host.logger.error(`${label} 试图注册路径 ${path}，含不能出现在 URL 里的字符，已拒绝`)
        return
      }
      host.route("GET", `${prefix}/${path.replace(/^\/+/, "")}`, handler)
    },
    config: <T,>(): T => host.config(configKeyOf(pkg)) as T
  }

  try {
    await checked.server.setup(ctx)
  } catch (err) {
    host.logger.error(`${label} 的 node 侧 setup 抛错：${err instanceof Error ? err.message : String(err)}`)
    return false
  }

  host.logger.debug(`${label} 的 node 侧已加载，接口前缀 ${base}`)
  return true
}

/**
 * 逐个加载全部包的 node 侧入口
 *
 * 并发加载：每个包一次 `import()`，串行的话 n 个包就是 n 次磁盘往返串起来，而插件
 * 加载有超时。**一个失败不连坐其余** —— `loadPanelServer` 自己不抛错。
 * @param host webui 侧能力
 * @param packages 全部包
 * @returns 成功加载了 node 侧的包名集合
 */
export async function loadPanelServers(host: ServerHost, packages: readonly PanelPackage[]): Promise<Set<string>> {
  const withServer = packages.filter(pkg => pkg.serverEntry !== undefined)
  const results = await Promise.all(withServer.map(async pkg => ({ pkg, ok: await loadPanelServer(host, pkg) })))
  const loaded = new Set<string>()
  for (const item of results) if (item.ok) loaded.add(`${item.pkg.owner}/${item.pkg.name}`)
  return loaded
}
