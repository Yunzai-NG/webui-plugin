/**
 * 模块职责：面板插件入口 —— 将前端产物挂载至站点根路径，并把面板插件的目录挂出去
 * 依赖方向：依赖 `@yunzai-ng/core` 的公开入口与本目录的 panelscan
 * 生命周期：随插件加载与卸载；`ctx.panel()` 返回的 Disposer 由内核在卸载时执行
 * 注意事项：面板插件只有一处落点：本插件安装目录下的 `plugins/`。面板自己的内置组件
 *          （`web/src/widgets/`）编译进前端产物、由 `registry.ts` 直接注册，不经扫描。
 *
 *          目录只在 `setup()` 时挂一次，清单端点每次请求都重扫，故新增文件刷新页面即生效；
 *          node 侧入口只在 `setup()` 时加载一次，那一半要重载 webui。
 *
 *          webui 自己的写路由要自行判定只读（商店四条 + 面板插件配置两条）：内核的
 *          `requireWritable()` 只拦 `/api` 之下的请求，管不到本插件的 scope。
 *
 *          产物目录取自 `import.meta.dirname` 而非 `process.cwd()`：以服务或 pm2 方式启动时工作目录
 *          并非插件目录。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { HttpClient } from "@yunzai-ng/types"
import { CORE_CONFIG_NAME, definePlugin, parseDuration, parseYaml } from "@yunzai-ng/core"
import { readCoreSettings } from "./coreconfig.js"
import { PanelConfigStore, configKeyOf } from "./panelconfig.js"
import { panelsDir, scanPanels, type PanelEntry, type PanelPackage } from "./panelscan.js"
import { loadPanelServers } from "./panelserver.js"
import { PanelStore, STORE_CACHE_FILE, type PanelStoreSettings } from "./panelstore.js"
import { DEFAULT_STORE_INDEX, webuiConfigSchema, type WebuiConfig } from "./storeconfig.js"

/** 前端产物目录名，与 `web/vite.config.ts` 的 outDir 末段一致 */
const WEB_DIR = "web"

/** 产物存在的判据：单页应用的入口文件 */
const ENTRY = "index.html"

/**
 * 面板插件清单的文件名，**不含前导斜杠**（由调用点拼）
 *
 * 与 `web/src/panelload.ts` 里的同名地址必须一致。前端拉的是 `/plugin/webui/panels.json`，
 * 不在 `/api` 之下，故前端要用 `getAt()` 而非 `get()`。
 */
export const PANELS_ENDPOINT = "panels.json"

/**
 * 面板插件包配置的写端点前缀，**不含前导斜杠**
 *
 * 读不在这里 —— 值随清单一并送出（见 `mountPanelPlugins`）。
 * `PUT <前缀>/:owner/:name` 存整份值，`POST <前缀>/:owner/:name/reset` 恢复默认值，
 * 两条各自经 `readonlyRefusal()` 判定只读。
 */
export const PANEL_CONFIG_ENDPOINT = "panelconfig"

/**
 * 面板插件商店的端点前缀，**不含前导斜杠**
 *
 * 五条：`GET <前缀>` 列出、`POST <前缀>/refresh` 强制回源、`POST <前缀>/install` 装、
 * `POST <前缀>/:name/update` 更、`DELETE <前缀>/:name` 删。
 *
 * 落在 webui 自己的 scope 而非 `/api` 之下，内核的只读模式拦不到，故四条写路由各自读一次
 * `server.readonly` 自行拒绝（见 `coreconfig.ts`）。
 */
export const PANEL_STORE_ENDPOINT = "panelstore"

/**
 * 一条路由收到的请求里，本插件用得到的那两项
 *
 * 以结构类型声明而非引用内核的 `RouteRequest`，使测试无须构造完整请求。
 */
export interface PanelRequest {
  /** 路径参数，`:owner` / `:name` 即在此 */
  readonly params: Readonly<Record<string, string>>
  /** 已解析的请求体；无体时 undefined */
  readonly body: unknown
}

/**
 * 本插件用到的上下文能力
 *
 * 以结构类型声明而非 `Pick<PluginContext, ...>`，使测试无须构造一份完整的 `PluginContext`。
 * 真实 `ctx` 天然满足它。
 */
export interface PanelHost {
  /** 插件专属日志器 */
  readonly logger: {
    /** 记一条警告 */
    warn(msg: string): void
    /** 记一条错误 */
    error(msg: string): void
    /** 记一条调试信息 */
    debug(msg: string): void
  }
  /**
   * 本插件专属数据目录
   *
   * 只作为受限上下文里的 `dataDir` 交给带 node 侧的面板插件包 —— 一个包要存东西时该存进
   * 数据目录而非自己的安装目录。不用于扫描面板插件。
   */
  readonly dataDir: string
  /**
   * 接管站点根路径
   * @param dir 单页应用产物目录（绝对路径）
   * @returns 注销句柄
   */
  panel(dir: string): unknown

  /**
   * 挂载静态目录
   * @param urlPath 相对本插件 scope 的 URL 路径
   * @param dir 本地目录绝对路径
   * @returns 注销句柄
   */
  static(urlPath: string, dir: string): unknown

  /**
   * 注册路由
   * @param method HTTP 方法
   * @param path 相对本插件 scope 的路径
   * @param handler 处理函数
   * @returns 注销句柄
   */
  route(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    handler: (req: PanelRequest) => unknown
  ): unknown

  /**
   * HTTP 客户端，取索引用
   *
   * 用内核给的这一份而非 `fetch`：它已带全局代理与超时默认值，而代理恰是国内网络下
   * 「取不到索引」最常见的原因。
   */
  readonly http: HttpClient

  /** 本插件版本，`minWebui` 的判据 */
  readonly version: string

  /** 应用只读视图；此处只用到 `paths`（配置目录与临时目录） */
  readonly app: {
    /** 目录布局 */
    readonly paths: {
      /** 配置目录，内核配置文件即在其下 */
      readonly config: string
      /** 临时目录，下载与解包在此完成 */
      readonly temp: string
    }
  }

  /** 本插件的配置句柄，读商店那三项设置 */
  readonly config: {
    /**
     * 取当前配置
     * @returns 配置快照
     */
    get(): unknown
  }
}

/**
 * 由入口所在目录推出前端产物目录
 * @param base 入口文件所在目录
 * @returns 前端产物目录绝对路径
 */
export function webDirOf(base: string): string {
  return join(base, WEB_DIR)
}

/**
 * 由入口所在目录推出本插件的安装目录
 *
 * 入口是 `<安装目录>/dist/index.js`，故上推一级。面板插件落在安装目录下的 `plugins/`，
 * 不在 `dist/` 之下（`pnpm run build` 会清空它），也不在 `dataDir` 之下（那是另一处）。
 * @param base 入口文件所在目录，即 `dist/`
 * @returns 安装目录绝对路径
 */
export function rootOf(base: string): string {
  return join(base, "..")
}

/**
 * 挂载面板；产物缺失或根路径已被占用时只记日志
 *
 * `setup()` 无论成败都正常返回：面板打不开不影响机器人收发消息。
 * @param ctx 插件上下文
 * @param dir 前端产物目录
 * @returns 是否已成功接管根路径
 */
export function mountPanel(ctx: PanelHost, dir: string): boolean {
  if (!existsSync(join(dir, ENTRY))) {
    ctx.logger.warn(`未找到面板前端产物（${dir}）。在插件目录执行 pnpm run build:web 后重载本插件`)
    return false
  }

  try {
    ctx.panel(dir)
    ctx.logger.debug(`面板已挂载：${dir}`)
    return true
  } catch (err) {
    // 根路径已被另一个插件接管，或内置服务器未启用
    ctx.logger.error(`面板挂载失败：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * 读内核配置里 webui 用得到的两项
 *
 * 把 `ctx` 与 `coreconfig.ts` 的纯逻辑接起来。
 * @param ctx 插件上下文
 * @returns 镜像前缀与只读开关
 */
async function coreSettingsOf(ctx: PanelHost): Promise<{ mirror: string; readonly: boolean }> {
  return readCoreSettings({
    configDir: ctx.app.paths.config,
    configName: CORE_CONFIG_NAME,
    parse: parseYaml,
    debug: msg => ctx.logger.debug(msg)
  })
}

/**
 * 取商店那三项设置
 *
 * 每次调用都重读 `ctx.config.get()`，不在 `setup` 里取一次存起来：否则改了索引地址要重启才生效。
 * `s.duration()` 兼收 `"1h"` 与毫秒数，故一律经 `parseDuration` 换算 —— 商店内部只认毫秒。
 * 取不到配置时退回默认值。
 * @param ctx 插件上下文
 * @returns 商店设置
 */
function storeSettingsOf(ctx: PanelHost): PanelStoreSettings {
  const raw = ctx.config.get() as Partial<WebuiConfig> | undefined
  const store = raw?.store
  const sources = Array.isArray(store?.sources) && store.sources.length > 0 ? store.sources : [DEFAULT_STORE_INDEX]
  return {
    sources,
    cacheTtl: parseDuration(store?.cacheTtl, 60 * 60 * 1000),
    timeout: parseDuration(store?.timeout, 15 * 1000)
  }
}

/**
 * 开出面板插件商店的五条路由
 *
 * `GET` 那条把只读开关一并送出供前端隐去按钮，四条写路由各自还要再判一次 —— 前端那份挡不住
 * 直接发来的请求，node 侧那份才是门。
 *
 * 装与更两条收一个 `dependencies` 标志（要不要跑包管理器），由前端的确认框勾选决定：
 * 跑包管理器等于执行第三方的 install 脚本，该由使用者按下。
 * @param ctx 插件上下文
 * @param webuiRoot webui 自己的安装目录
 * @returns 商店实例，供测试断言
 */
export function mountPanelStore(ctx: PanelHost, webuiRoot: string): PanelStore {
  const store = new PanelStore({
    http: ctx.http,
    logger: ctx.logger,
    panelsDir: panelsDir(webuiRoot),
    tempDir: ctx.app.paths.temp,
    cacheFile: join(ctx.dataDir, STORE_CACHE_FILE),
    settings: () => storeSettingsOf(ctx),
    core: () => coreSettingsOf(ctx),
    webuiVersion: ctx.version
  })

  /**
   * 把一次失败说成一个响应
   *
   * 商店的失败多半使用者可自行处置（源不通、名字不在索引里、目录已存在、只读模式、git 不可用），
   * 故一律给 400 并把原话带上，而不是抛成 500「内部错误」。
   * @param err 捕获到的错误
   * @returns 响应
   */
  const failed = (err: unknown): { status: number; body: { error: string } } => {
    const error = err instanceof Error ? err.message : String(err)
    // 只读那一条是 403 而非 400：它不是「请求写错了」，而是「这台实例现在不接受写」
    const status = error.includes("只读模式") ? 403 : 400
    return { status, body: { error } }
  }

  /**
   * 从请求体里取包名
   * @param body 请求体
   * @returns 包名；缺失时空串
   */
  const nameOf = (body: unknown): string => {
    if (typeof body !== "object" || body === null) return ""
    const value = (body as { name?: unknown }).name
    return typeof value === "string" ? value.trim() : ""
  }

  /**
   * 从请求体里取「要不要跑包管理器」
   *
   * 缺省为 false：没写这一项的请求不该被当成「同意执行第三方脚本」。
   * @param body 请求体
   * @returns 是否跑包管理器
   */
  const wantsDeps = (body: unknown): boolean =>
    typeof body === "object" && body !== null && (body as { dependencies?: unknown }).dependencies === true

  ctx.route("GET", `/${PANEL_STORE_ENDPOINT}`, async () => store.list())

  ctx.route("POST", `/${PANEL_STORE_ENDPOINT}/refresh`, async () => store.list(true))

  ctx.route("POST", `/${PANEL_STORE_ENDPOINT}/install`, async req => {
    try {
      return await store.install(nameOf(req.body), { dependencies: wantsDeps(req.body) })
    } catch (err) {
      return failed(err)
    }
  })

  ctx.route("POST", `/${PANEL_STORE_ENDPOINT}/:name/update`, async req => {
    try {
      return await store.update(req.params.name ?? "", { dependencies: wantsDeps(req.body) })
    } catch (err) {
      return failed(err)
    }
  })

  ctx.route("DELETE", `/${PANEL_STORE_ENDPOINT}/:name`, async req => {
    try {
      const name = req.params.name ?? ""
      const removed = await store.remove(name)
      if (!removed) return { status: 404, body: { error: `面板插件 ${name} 的目录不存在，无须删除` } }
      return { removed: true, name }
    } catch (err) {
      return failed(err)
    }
  })

  return store
}

/**
 * 挂载面板插件目录，并开出清单端点
 *
 * 清单端点每次被请求时重扫，静态目录只在此刻挂一次，故新增文件刷新页面即生效。清单滤掉未挂载
 * 的归属：那些目录的浏览器侧取不到，列进去只会让 `import()` 拿到 404。
 *
 * 配置的值随清单一并送出，不另开读端点：schema 与值永远同时用到，分两次请求会出现
 * 「schema 是新的、值是旧的」这半拍窗口。写另有两条路由，见 `PANEL_CONFIG_ENDPOINT`。
 * @param ctx 插件上下文
 * @param webuiRoot webui 自己的安装目录；`plugins/` 即在其下
 * @returns 已挂载的归属集合，供测试断言
 */
export async function mountPanelPlugins(ctx: PanelHost, webuiRoot: string): Promise<Set<string>> {
  const first = await scanPanels({ webuiRoot, warn: msg => ctx.logger.warn(msg) })

  const mounted = new Set<string>()
  for (const mount of first.mounts) {
    try {
      ctx.static(mount.urlPath, mount.dir)
      mounted.add(mount.owner)
    } catch (err) {
      ctx.logger.error(`面板插件目录 ${mount.dir} 挂载失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const store = new PanelConfigStore(ctx.dataDir, ctx.logger)

  // 配置须在 node 侧入口之前读进来：包的 `setup(ctx)` 里就可能调 `ctx.config()`，
  // 那一刻值还没读进来它拿到的是空对象

  await Promise.all(first.packages.filter(pkg => pkg.config !== undefined).map(pkg => store.ensure(pkg)))

  /*
   * node 侧入口只在此刻加载一次，与清单端点的每次重扫刻意不同：重扫只读目录名，而这里是
   * `import()` 加一次 `setup()` —— 每刷新一次页面就重跑一遍别人的 setup，那个包预料不到。
   *
   * 只加载已挂载归属下的包：浏览器侧取不到时，node 侧跑起来也没人调用。
   */
  const servers = await loadPanelServers(
    {
      dataDir: ctx.dataDir,
      logger: ctx.logger,
      route: ctx.route.bind(ctx),
      config: key => store.get(key)
    },
    first.packages.filter(pkg => mounted.has(pkg.owner))
  )

  /**
   * 重扫一遍，按归属与包名找出一个包
   *
   * 写路由不吃启动时那份 `first`：一个包可能是启动之后才放进去的，而它的配置同样该改得动。
   * @param owner 归属
   * @param name 包名
   * @returns 找到的包；没有时 undefined
   */
  const packageOf = async (owner: string, name: string): Promise<PanelPackage | undefined> => {
    const now = await scanPanels({ webuiRoot, warn: () => undefined })
    return now.packages.find(pkg => pkg.owner === owner && pkg.name === name && mounted.has(pkg.owner))
  }

  /**
   * 只读模式下给出一个 403，否则给 undefined 放行
   *
   * 内核的 `requireWritable()` 只拦 `/api` 之下的写请求，而这两条落在 webui 自己的 scope 里，
   * 故自己读 `server.readonly`（见 `coreconfig.ts`）。文案与内核那条逐字一致 —— 挡住使用者的是
   * 哪一侧属于实现细节。
   * @returns 只读时给出 403 响应，否则 undefined
   */
  const readonlyRefusal = async (): Promise<{ status: number; body: { error: string } } | undefined> => {
    const settings = await coreSettingsOf(ctx)
    if (!settings.readonly) return undefined
    return {
      status: 403,
      body: { error: "面板处于只读模式（配置项 server.readonly 为 true），不能执行写操作" }
    }
  }

  ctx.route("GET", `/${PANELS_ENDPOINT}`, async () => {
    // 重扫时不再重复告警：启动时已说过一遍，每次刷新页面再说一遍只会淹掉日志
    const now = await scanPanels({ webuiRoot, warn: () => undefined })
    const packages = new Map(now.packages.map(pkg => [configKeyOf(pkg), pkg]))
    const items: PanelEntry[] = []

    for (const entry of now.entries) {
      if (!mounted.has(entry.owner)) continue
      const key = `${entry.owner}/${entry.file.split("/")[0] ?? ""}`
      let item: PanelEntry = entry

      // node 侧没加载成功的包不给 api 地址：声明了不等于跑起来了（缺依赖、语法错、setup 抛错），
      // 留着会让组件去调一个稳定 404 的接口

      if (item.api !== undefined && !servers.has(key)) {
        const { api: _api, ...rest } = item
        item = rest
      }

      const pkg = packages.get(key)
      if (pkg?.config !== undefined) {
        item = { ...item, config: { schema: pkg.config, value: await store.ensure(pkg) } }
      }
      if (pkg?.configError !== undefined) item = { ...item, configError: pkg.configError }
      items.push(item)
    }
    return { items }
  })

  // 整份提交，不走补丁：schema 与值来自同一个包的同一份 package.json，不存在内核配置那边
  // 「产物版本低于内核」的字段错位
  ctx.route("PUT", `/${PANEL_CONFIG_ENDPOINT}/:owner/:name`, async req => {
    const denied = await readonlyRefusal()
    if (denied !== undefined) return denied
    const owner = req.params.owner ?? ""
    const name = req.params.name ?? ""
    const pkg = await packageOf(owner, name)
    if (pkg === undefined) return { status: 404, body: { error: `没有名为 ${owner}/${name} 的面板插件包` } }

    const done = await store.save(pkg, req.body)
    if (!done.ok) {
      // 形制同内核配置的 400：`issues` 原样送出，表单据此把错标到具体字段上
      return { status: 400, body: { error: "配置未保存：有字段与这个包的声明不符", issues: done.issues } }
    }
    return { value: done.value, issues: done.issues }
  })

  ctx.route("POST", `/${PANEL_CONFIG_ENDPOINT}/:owner/:name/reset`, async req => {
    const denied = await readonlyRefusal()
    if (denied !== undefined) return denied
    const owner = req.params.owner ?? ""
    const name = req.params.name ?? ""
    const pkg = await packageOf(owner, name)
    if (pkg === undefined) return { status: 404, body: { error: `没有名为 ${owner}/${name} 的面板插件包` } }
    return { value: await store.reset(pkg) }
  })

  const count = first.entries.filter(entry => mounted.has(entry.owner)).length
  const configured = first.packages.filter(pkg => pkg.config !== undefined).length
  ctx.logger.debug(
    `面板插件：${mounted.size} 处目录、${count} 个文件、${servers.size} 个 node 侧入口、${configured} 个带配置项的包`
  )
  return mounted
}

export default definePlugin({
  name: "webui",

  /** webui 自己的配置项：只有商店那三项。镜像前缀与只读开关读内核的，见 `storeconfig.ts` */
  configSchema: webuiConfigSchema,

  async setup(ctx) {
    mountPanel(ctx, webDirOf(import.meta.dirname))

    // 面板插件挂不上只是少几个组件，向上抛则整个 webui 加载失败 —— 使用者会因一个自选组件
    // 失去整个面板
    try {
      await mountPanelPlugins(ctx, rootOf(import.meta.dirname))
    } catch (err) {
      ctx.logger.error(`面板插件加载失败，面板本身不受影响：${err instanceof Error ? err.message : String(err)}`)
    }

    /*
     * 商店单独一次 try，与面板插件的加载互不连坐：商店开不出来只是少一页「去哪装新的」，并进
     * 上面那次 try 会让它连带吃掉已装组件的加载，使用者眼里则是「我的组件全没了」。
     */
    try {
      mountPanelStore(ctx, rootOf(import.meta.dirname))
    } catch (err) {
      ctx.logger.error(`面板插件商店开启失败，已装的面板插件不受影响：${err instanceof Error ? err.message : String(err)}`)
    }
  }
})
