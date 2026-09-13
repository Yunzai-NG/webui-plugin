/**
 * 模块职责：插件自定义页面 —— 扫描 `webadapter/`、收一个页面描述符、挂它的静态资源与只读接口
 * 依赖方向：只依赖 node 内置模块与本目录的 panelserver（借它的路径校验）；不 import 内核，也不认识 Vue
 * 生命周期：`setup()` 时逐个加载；路由由内核随 webui 一并回收，故此处不必自己撤
 * 注意事项：**每个插件只有一个页面**，先注册的那个作数，之后的一律警告后丢弃。这不是省事 ——
 *          左侧导航是使用者找东西的地方，一个插件能占任意多项时，装三五个插件就把导航挤满，
 *          而挤占的代价由其他插件承担，不由挤占者承担。想放多块内容的插件在自己那一页里分区。
 *
 *          registerApi **只给 GET。**显式 configurable 页面通过受限数据桥读写自己的
 *          `/api/config/<插件名>`，由内核执行配置校验、只读模式与日志，不增加裸写接口。
 *
 *          **`apiPath` 必须过 `isSafeRoutePath()`**，理由与面板插件同（见 panelserver.ts）：
 *          路径里带 `..` 或绝对路径能让一个插件的接口落到另一个插件的前缀下，悄悄接管它的数据。
 *
 *          **页面标识全局唯一，由「插件名」担保**：对外的 id 一律是插件目录名，不收插件自报的 id。
 *          两个插件都想叫 `stats` 时，前端按 id 找页会串到另一家的页面上，而这种错极难看出来 ——
 *          页面能打开，只是内容不对。
 *
 *          坏插件逐个 try 隔离：语法错、`init` 抛错、import 到不存在的文件，任何一条冒到 webui 的
 *          `setup()` 都会让整个面板打不开，使用者眼里是「装了个插件，面板没了」。
 */
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { isSafeRoutePath } from "./panelserver.js"
import { isImageIcon, loadImageIcon } from "./customicon.js"

/** 一个插件页面的描述符，`GET /plugin/webui/custom-pages` 返回其数组 */
export interface CustomPage {
  /** 页面标识，取插件目录名，全局唯一 */
  readonly id: string
  /** 导航与页头显示的文案 */
  readonly title: string
  /** 一句话说明，显示在页头副标题 */
  readonly sub?: string
  /** 提供者显示名，缺省为插件目录名 */
  readonly provider: string
  /** 页面 HTML 的地址，前端据此加载 iframe */
  readonly url: string
  /** emoji 文本或服务器读取声明图片后生成的数据 URL */
  readonly icon: string
  /** 显式允许页面读写本插件配置，默认关闭 */
  readonly configurable?: boolean
}

/** 插件在 `webadapter/index.js` 里注册页面时给的内容 */
export interface CustomPageInput {
  /** 导航文案；缺省取插件目录名 */
  title?: string
  /** 一句话说明 */
  sub?: string
  /** 提供者显示名 */
  provider?: string
  /** 页面入口文件名，相对 `webadapter/`，缺省 `index.html` */
  src?: string
  /** emoji 或相对插件根目录的图片路径，如 src/logo.png；默认 📄 */
  icon?: string
  /** 开放本插件自己的配置通道，不允许指定其他配置名 */
  configurable?: boolean
}

/** 传给 `webadapter/index.js` 的 `init()` 的上下文 */
export interface CustomPageContext {
  /** 插件目录名，同时也是页面标识与接口前缀 */
  readonly pluginName: string
  /** `webadapter/` 目录绝对路径，页面的静态资源都从这里发出 */
  readonly pluginDir: string
  /** 内核配置目录，插件读自己的配置文件用 */
  readonly configDir: string
  /**
   * 注册本插件的页面，**只有第一次调用生效**
   * @param page 页面内容
   */
  registerPage(page: CustomPageInput): void
  /**
   * 注册一条只读接口，落在 `/plugin/webui/custom/<插件名>/` 之下
   * @param apiPath 相对路径，如 `stats`
   * @param handler 处理函数，返回值即响应体
   */
  registerApi(apiPath: string, handler: (req: { params: Record<string, string> }) => unknown): void
}

/** 页面入口的缺省文件名 */
const DEFAULT_SRC = "index.html"

/** webui 自己的路由前缀，与 `index.ts` 的挂载一致 */
const PREFIX = "/plugin/webui"

/** `webadapter/` 下的 node 侧入口文件名 */
const ENTRY = "index.js"

/** 本模块用到的 webui 上下文子集，只列真正调用的四项 */
interface Ctx {
  static(path: string, dir: string): unknown
  route(method: "GET", path: string, handler: (req: { params: Record<string, string> }) => unknown): unknown
  logger: { warn(msg: string): void }
  app: { paths: { config: string } }
}

/**
 * 页面入口文件名是否可用作静态路径的一段
 *
 * 与 `isSafeRoutePath` 分开：入口是**文件**，不能是目录、不能带查询串，且必须落在
 * `webadapter/` 之内。`..` 由 `isSafeRoutePath` 拒掉，前导斜杠在此拒掉 —— 那会让
 * 拼出来的 URL 变成绝对路径，脱离本插件的前缀。
 * @param src 插件自报的入口文件名
 * @returns 可用则为真
 */
function isSafeSrc(src: string): boolean {
  return src !== "" && !src.startsWith("/") && isSafeRoutePath(src)
}

/**
 * 扫描插件目录，为每个带 `webadapter/` 的插件挂一个页面
 *
 * 挂载后前端可 `GET /plugin/webui/custom-pages` 取清单。**清单本身要令牌**（`ctx.route` 默认如此），
 * 而页面的静态资源不要 —— 后者是内核对静态挂载的既定取舍：HTML/JS 本身不是机密，要保护的是接口。
 * @param ctx webui 的插件上下文
 * @param pluginsDir 内核的 plugins 目录
 */
export async function mountCustomPages(ctx: Ctx, pluginsDir: string): Promise<void> {
  const pages: CustomPage[] = []
  let dirs: string[] = []
  // 目录读不到就是没有插件可扫（全新安装尚未建 plugins 目录），不是错误
  try {
    dirs = (await readdir(pluginsDir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name)
  } catch {
    dirs = []
  }

  for (const plugin of dirs) {
    const dir = join(pluginsDir, plugin, "webadapter")
    const entry = join(dir, ENTRY)
    if (!existsSync(entry)) continue

    // 插件目录名会直接进 URL，含空格或中文的目录名拼出来的路径无法稳定匹配
    if (!isSafeRoutePath(plugin)) {
      ctx.logger.warn(`自定义页面 ${plugin}：插件目录名含 URL 不安全的字符，已跳过`)
      continue
    }

    try {
      const mod = (await import(pathToFileURL(entry).href)) as {
        init?: (context: CustomPageContext) => void | Promise<void>
        default?: CustomPageInput
        page?: CustomPageInput
      }

      let page: CustomPage | undefined
      /*
       * 「插件表过态」与「表态被接受」是两件事，故另立一个标记
       *
       * 只看 `page === undefined` 的话，一次被拒的注册（入口越界）之后仍会走到末尾那句兜底，
       * 于是照缺省的 index.html 挂上 —— 使用者写错了路径却看到页面能开，只是内容不对，
       * 而警告早已滚出屏幕。注册过就到此为止，对错都不再替它猜。
       */
      let declaredOnce = false
      /**
       * 收下一个页面描述符，第二次起只警告
       * @param input 插件给的页面内容
       */
      const take = (input: CustomPageInput): void => {
        if (declaredOnce) {
          ctx.logger.warn(`自定义页面 ${plugin}：每个插件只能注册一个页面，已忽略多出的一个`)
          return
        }
        declaredOnce = true
        const src = typeof input.src === "string" && input.src !== "" ? input.src : DEFAULT_SRC
        if (!isSafeSrc(src)) {
          ctx.logger.warn(`自定义页面 ${plugin}：入口 ${src} 不是合法的相对文件路径，已跳过`)
          return
        }
        page = {
          id: plugin,
          title: typeof input.title === "string" && input.title !== "" ? input.title : plugin,
          ...(typeof input.sub === "string" && input.sub !== "" ? { sub: input.sub } : {}),
          provider: typeof input.provider === "string" && input.provider !== "" ? input.provider : plugin,
          url: `${PREFIX}/custom/${plugin}/${src}`,
          icon: typeof input.icon === "string" && input.icon.trim() !== "" ? input.icon.trim() : "📄",
          ...(input.configurable === true && /^[a-z][a-z0-9._-]*$/i.test(plugin) && plugin.toLowerCase() !== "yunzai"
            ? { configurable: true } : {})
        }
      }

      if (typeof mod.init === "function") {
        await mod.init({
          pluginName: plugin,
          pluginDir: dir,
          configDir: ctx.app.paths.config,
          registerPage: take,
          registerApi: (apiPath, handler) => {
            // 剥掉**所有**前导斜杠而非一个：只剥一个的话 `//stats` 剩下 `/stats`，
            // 仍能过下面的校验（`/` 在允许的字符集里），拼出的路径带个空段。
            // 前端那道闸（web/src/custombridgegate.ts）用同一套剥法，两边必须一致 ——
            // 否则插件写 `/stats` 注册得上，页面按同样的写法却取不到。
            const clean = apiPath.replace(/^\/+/, "")
            if (!isSafeRoutePath(clean)) {
              ctx.logger.warn(`自定义页面 ${plugin}：接口路径 ${apiPath} 不合法，未注册`)
              return
            }
            ctx.route("GET", `/custom/${plugin}/api/${clean}`, handler)
          }
        })
      }

      // 只画一页、不需要 node 侧逻辑的插件可以直接默认导出描述符，不必写 init
      const declared = mod.default ?? mod.page
      if (!declaredOnce && declared !== undefined && typeof declared === "object") take(declared)
      // 连描述符都没有也算注册成功：`webadapter/index.html` 加一个空的 index.js 就够了
      if (!declaredOnce) take({})

      if (page !== undefined) {
        if (isImageIcon(page.icon)) {
          try {
            page = { ...page, icon: await loadImageIcon(join(pluginsDir, plugin), page.icon) }
          } catch (error) {
            ctx.logger.warn(`自定义页面 ${plugin} 图标读取失败，使用默认图标：${error instanceof Error ? error.message : String(error)}`)
            page = { ...page, icon: "📄" }
          }
        } else {
          page = { ...page, icon: page.icon.slice(0, 64) }
        }
        pages.push(page)
        ctx.static(`custom/${plugin}`, dir)
      }
    } catch (error) {
      ctx.logger.warn(`自定义页面 ${plugin} 加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.route("GET", "/custom-pages", () => ({ pages }))
}
