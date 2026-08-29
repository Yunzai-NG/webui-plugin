/**
 * 模块职责：面板插件商店 —— 取索引与缓存、装 / 更 / 删一个面板插件包、按需跑包管理器
 * 依赖方向：依赖 node 内置模块、类型包与内核**导出的纯函数**；不认识 Vue
 * 生命周期：随 webui 的 `setup()` 创建一次，索引缓存驻留内存并落盘一份
 * 注意事项：版本门叫 `minWebui` 而非复用内核 `PluginMarket` 的 `minCore`：面板插件要的能力
 *          （`api.config`、页签注册点、一个模块导出多枚组件）随 webui 版本走，塞进 `minCore` 会让
 *          使用者看到「要求内核 0.2.0」而他的内核没问题。
 *
 *          取源那一段与内核 `market.ts` 的 `#fetch` / `#tryPull` 同源，改一处要对着另一处看。
 *
 *          索引顶层键是 `panels` 而非 `plugins`：同名的话，把面板索引填进内核 `market.sources`
 *          会解析成功，于是列出一堆装到错地方的条目。本模块也不认 `{plugins:[...]}` 与顶层数组，双向都挡。
 *
 *          只装「包」，不装单文件：商店要比较版本，而版本号只有 package.json 里那份 node 读得到。
 *
 *          判「像不像面板插件包」比内核严一档，package.json 与 `index.js` 都要有：入口固定是包根的
 *          `index.js`，缺它装完会被扫描器跳过，表现为「装上了却什么都没有」。
 *
 *          四项安全约定与内核一致：名字先过白名单再经 `joinWithin`；先下载到临时目录、校验通过才移入
 *          落点；索引按不可信输入对待，缺字段的条目整条丢弃；归档有体积上限。与内核不同的一处是本模块
 *          会跑包管理器，但要经使用者勾选 —— 理由见 `#finish`。
 */
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"
import type { HttpClient } from "@yunzai-ng/types"
import {
  applyMirror,
  compareVersion,
  extractTarGz,
  isDirectory,
  isFile,
  joinWithin,
  singleRoot,
  tarballFromGit,
  type GitRunner
} from "@yunzai-ng/core"
import { MULTI_ENTRY } from "./panelscan.js"

/** 合法包名：与内核的 NAME_RE 及扫描器的 `isSafeName` 交集一致 */
const NAME_RE = /^[a-z\d][a-z\d._-]*$/i

/**
 * 保留名，一律不放行
 *
 * 它们全是合法目录名，`NAME_RE` 挡不住，但落在落点之内会破坏运行环境（一个叫
 * `node_modules` 的包与包管理器建的那个目录同名）。判定放在解析那一步而非安装那一步：
 * 只在安装时挡，列表里仍会出现一张点了必报错的卡片。
 */
const RESERVED_NAMES: readonly string[] = ["node_modules", "package.json", "dist"]

/**
 * 包名是否可用
 *
 * 白名单加保留名两道。采白名单而非黑名单的理由同内核：路径越界校验能拦住 `../`，
 * 但拦不住落在目录之内却会破事的名字。
 * @param name 包名
 * @returns 是否放行
 */
export function isUsableName(name: string): boolean {
  if (!NAME_RE.test(name) || name.startsWith(".")) return false
  return !RESERVED_NAMES.includes(name.toLowerCase())
}

/** 安装归档的体积上限，同内核 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/** 克隆与下载的超时毫秒，同内核：一次传输可达数十 MB，不能按索引超时衡量 */
const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000

/** 只读本地仓库的 git 命令超时毫秒；不含网络往返，故与传输超时分开取值 */
const GIT_LOCAL_TIMEOUT_MS = 10_000

/**
 * 包管理器安装的超时毫秒
 *
 * 比传输超时更长：国内网络下一次冷装依赖十分钟并不罕见，而超时的后果是留下一个
 * 装了一半的 `node_modules` —— 那比等着更难查。
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** 索引缓存的文件名，落在 webui 的数据目录下 */
export const STORE_CACHE_FILE = "panelstore-cache.json"

/** 面板插件的安装来源 */
export interface PanelInstallSpec {
  /** 取源方式 */
  readonly type: "git" | "tarball"
  /** 仓库地址或归档地址 */
  readonly url: string
  /** git 分支，缺省由远端决定 */
  readonly branch?: string
}

/** 索引中的一个面板插件条目 */
export interface PanelStoreEntry {
  /** 包名，同时是安装目录名 */
  readonly name: string
  /** 展示标题 */
  readonly title: string
  /** 一句话说明 */
  readonly description: string
  /** 作者 */
  readonly author?: string
  /** 索引声明的版本 */
  readonly version?: string
  /** 项目主页 */
  readonly homepage?: string
  /** 分类标签 */
  readonly tags: readonly string[]
  /** 是否为官方维护 */
  readonly official: boolean
  /**
   * 要求的最低 **webui** 版本
   *
   * 不是内核版本。面板插件用的是 webui 给的注入口，故门在 webui 上；见文件头。
   */
  readonly minWebui?: string
  /** 组件数 —— 预告而非事实，真实数目要浏览器 `import()` 过才知道；仅供列表展示 */
  readonly widgets?: number
  /** 是否带 node 侧入口 —— 同为预告，装完以 package.json 为准 */
  readonly server?: boolean
  /** 是否声明了依赖 —— 同为预告，装完以 package.json 为准 */
  readonly deps?: boolean
  /** 安装来源 */
  readonly install: PanelInstallSpec
  /** 该条目来自哪个索引地址 */
  readonly source: string
}

/** 附带本地安装状态的条目 */
export interface PanelStoreListing extends PanelStoreEntry {
  /** 落点下是否已存在同名目录 */
  readonly installed: boolean
  /** 已装的版本，读自磁盘上的 package.json；未安装或读不到时 undefined */
  readonly installedVersion?: string
  /** 索引里的版本是否高于已装的版本；未安装时恒为 false */
  readonly updatable: boolean
}

/** 一个索引地址的获取结果 */
export interface PanelStoreSourceResult {
  /** 索引地址 */
  readonly url: string
  /** 是否取到并解析成功 */
  readonly ok: boolean
  /** 失败原因 */
  readonly error?: string
  /** 该索引贡献的条目数 */
  readonly count: number
}

/** 索引快照 */
export interface PanelStoreSnapshot {
  /** 获取时间戳 */
  readonly fetchedAt: number
  /** 是否来自缓存而非本次网络请求 */
  readonly cached: boolean
  /** 逐个索引的获取结果 */
  readonly sources: readonly PanelStoreSourceResult[]
  /** 合并去重后的条目，按名称排序 */
  readonly panels: readonly PanelStoreListing[]
  /** 面板是否处于只读模式；前端据此隐去写按钮 */
  readonly readonly: boolean
}

/**
 * 一次安装的取源方式
 *
 * `pull` 是更新独有的一种：目录已是 git 仓库，就地拉取而非重新下载。与 `git` 分开记录 ——
 * `pull` 保住了 `node_modules`，`git` 是一份全新的目录。同内核的 `InstallVia`。
 */
export type PanelInstallVia = PanelInstallSpec["type"] | "pull"

/** 一次安装或更新的结果 */
export interface PanelInstallResult {
  /** 包名 */
  readonly name: string
  /** 安装目录 */
  readonly dir: string
  /** 取源方式 */
  readonly via: PanelInstallVia
  /** package.json 中声明的版本；读不到时为索引声明的版本 */
  readonly version: string
  /** 是否声明了运行时依赖且尚未安装 */
  readonly needsDependencies: boolean
  /**
   * 是否带 node 侧入口，决定「装完要不要重载 webui」
   *
   * 只有浏览器侧的包刷新页面即生效，node 侧入口只在 `setup()` 里 import 一次，要重载
   * 才跑得起来。两种情形的下一步动作不同，故分开告知使用者。
   */
  readonly hasServer: boolean
  /**
   * 此后的更新会走哪条路，由 `via` 纯推导
   *
   * git 克隆与就地拉取都留下 `.git`，故此后可 `fetch` + `reset` 并保住包目录里的
   * `node_modules`；归档装出来的没有 `.git`，每次更新整目录重下、依赖跟着重装。
   */
  readonly updatable: "pull" | "reinstall"
  /** 就地拉取时的旧版本号，仅 `via` 为 `pull` 时存在 */
  readonly fromVersion?: string
  /** 就地拉取时是否确实有新提交；`false` 时面板说「已是最新版本」而非「已更新」 */
  readonly changed?: boolean
  /** 本次是否真的跑过包管理器 */
  readonly installedDeps?: boolean
  /** 跑包管理器时用的是哪个；未跑时 undefined */
  readonly packageManager?: string
  /** 跑包管理器失败的原因；成功或未跑时 undefined */
  readonly dependencyError?: string
}

/**
 * 由取源方式推出「此后的更新走哪条路」
 * @param via 本次的取源方式
 * @returns `pull` 表示目录带 `.git`、此后可就地拉取；`reinstall` 表示每次更新整目录重下
 */
function updatableOf(via: PanelInstallVia): "pull" | "reinstall" {
  return via === "tarball" ? "reinstall" : "pull"
}

/** 商店行为的可配置项，由 webui 自己的配置提供 */
export interface PanelStoreSettings {
  /** 索引地址列表，靠前者优先 */
  readonly sources: readonly string[]
  /** 索引缓存生存期毫秒 */
  readonly cacheTtl: number
  /** 单次索引请求超时毫秒 */
  readonly timeout: number
}

/** 构造商店所需的依赖 */
export interface PanelStoreDeps {
  /** HTTP 客户端，取自 `ctx.http` */
  readonly http: HttpClient
  /** 日志器 */
  readonly logger: { warn(msg: string): void; error(msg: string): void; debug(msg: string): void }
  /** 面板插件的落点：webui 安装目录下的 `plugins/` */
  readonly panelsDir: string
  /** 临时目录，下载与解包在此完成 */
  readonly tempDir: string
  /** 索引缓存文件路径 */
  readonly cacheFile: string
  /** 读取商店自己的设置 */
  readonly settings: () => PanelStoreSettings
  /** 读取内核那两项（镜像前缀与只读开关） */
  readonly core: () => Promise<{ mirror: string; readonly: boolean }>
  /** 当前 **webui** 版本，用于 `minWebui` 判定 */
  readonly webuiVersion: string
  /** 执行 git 命令，缺省调用本机的 git */
  readonly git?: GitRunner
  /**
   * 执行包管理器，缺省调用本机的 pnpm / npm
   *
   * 可注入是为让用例钉住实际下发的命令与参数：参数错掉（漏 `--prod`、跑错目录）同样
   * 会得到一个「命令成功了」的结果。
   * @param dir 包目录
   * @returns 用的是哪个包管理器
   */
  readonly install?: (dir: string) => Promise<string>
}

/**
 * 调用本机 git 执行一次命令，`PanelStoreDeps.git` 的缺省实现
 *
 * 与内核的 `runGit` 同义：参数以数组传递不经 shell（索引里的地址不会被当作命令解释），
 * `GIT_TERMINAL_PROMPT=0` 与 `GIT_ASKPASS` 关闭凭据提示 —— 安装在无人值守的请求里发生，
 * 弹出的提示无人应答，只会让请求挂到超时。内核那一份未导出，故此处另写一遍。
 * @param args 命令参数
 * @param cwd 工作目录
 * @param timeout 超时毫秒
 * @returns 标准输出
 * @throws 命令不存在、超时或退出码非零时
 */
const runGit: GitRunner = (args, cwd, timeout) => {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} 失败：${stderr.trim() || err.message}`))
        else resolve(stdout)
      }
    )
  })
}

/**
 * 包管理器的候选，按优先级
 *
 * pnpm 在前：包多半照本项目的例子写，装出来的布局与包作者测过的一致。npm 是兜底，
 * 随 node 一起装。不认 yarn —— berry 默认不建 `node_modules`（PnP 模式），那时
 * `import()` node 侧入口会失败，而失败原因与包管理器的关系很难看出来。
 */
const PACKAGE_MANAGERS: readonly string[] = ["pnpm", "npm"]

/**
 * 在一个包目录里跑包管理器，`PanelStoreDeps.install` 的缺省实现
 *
 * `--omit=dev` / `--prod`：只装运行时依赖，devDependencies 运行期一个都用不到。
 *
 * 不加 `--ignore-scripts`：带 node 侧的包可能依赖原生模块（sqlite、sharp），install 脚本
 * 正是它们编译或下载预编译产物的地方，禁掉会装出一份 `require` 即报错的 `node_modules`，
 * 而报错信息指向缺少 `.node` 文件，离「我禁了脚本」很远。既然已明说要跑，就该跑成能用的。
 * @param dir 包目录
 * @returns 用的是哪个包管理器
 * @throws 全部候选都不可用，或安装失败时
 */
async function runInstall(dir: string): Promise<string> {
  const errors: string[] = []
  for (const pm of PACKAGE_MANAGERS) {
    const args = pm === "pnpm" ? ["install", "--prod"] : ["install", "--omit=dev"]
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          pm,
          args,
          { cwd: dir, timeout: INSTALL_TIMEOUT_MS, env: { ...process.env }, windowsHide: true, shell: process.platform === "win32" },
          (err, _stdout, stderr) => {
            if (err) reject(new Error(stderr.trim() || err.message))
            else resolve()
          }
        )
      })
      return pm
    } catch (err) {
      errors.push(`${pm}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`包管理器均不可用或安装失败 —— ${errors.join("；")}`)
}

/** 磁盘缓存的文档结构 */
interface CacheFile {
  /** 获取时间戳 */
  fetchedAt: number
  /** 条目列表 */
  entries: PanelStoreEntry[]
}

/** package.json 里与安装相关的字段 */
interface PanelManifest {
  /** 版本号 */
  version?: string
  /** 运行时依赖 */
  dependencies?: Record<string, string>
  /** 是否声明了 node 侧入口 */
  hasServer: boolean
  /** 包自己说「无须装依赖」（`webuiPanel.install: false`） */
  skipInstall: boolean
}

/**
 * 面板插件商店
 *
 * 索引缓存同时驻留内存与磁盘：磁盘那份服务于重启后的首次打开 —— 无网络时也该列出上次
 * 看到的东西，而不是一个空列表。与内核 `PluginMarket` 同一形制。
 */
export class PanelStore {
  /** 依赖 */
  readonly #deps: PanelStoreDeps

  /** 内存中的索引条目 */
  #entries: PanelStoreEntry[] = []

  /** 内存索引的获取时间，0 表示尚未取到 */
  #fetchedAt = 0

  /** 逐源结果，随索引一同更新 */
  #sources: PanelStoreSourceResult[] = []

  /** 正在进行的索引获取，用于合并并发请求 */
  #inflight: Promise<void> | undefined

  /** git 可用性探测结果 */
  #gitAvailable: boolean | undefined

  /** 执行 git 命令 */
  readonly #git: GitRunner

  /** 执行包管理器 */
  readonly #install: (dir: string) => Promise<string>

  /**
   * @param deps 依赖
   */
  constructor(deps: PanelStoreDeps) {
    this.#deps = deps
    this.#git = deps.git ?? runGit
    this.#install = deps.install ?? runInstall
  }

  /**
   * 列出商店里的面板插件
   *
   * 缓存未过期时不发起网络请求。安装状态与已装版本每次都重读文件系统：使用者可能在面板之外
   * 手动删了包目录，沿用缓存会让「删除」按钮对着一个不存在的目录。
   * @param force 忽略缓存，强制重新获取
   * @returns 索引快照
   */
  async list(force = false): Promise<PanelStoreSnapshot> {
    const settings = this.#deps.settings()
    const fresh = this.#fetchedAt > 0 && Date.now() - this.#fetchedAt < settings.cacheTtl
    const cached = !force && fresh
    if (force || !fresh) await this.#refresh(force)

    const panels: PanelStoreListing[] = []
    for (const entry of this.#entries) {
      const dir = this.#dirOf(entry.name)
      const installed = dir === undefined ? false : await isDirectory(dir)
      const version = installed && dir !== undefined ? (await this.#manifest(dir))?.version : undefined
      panels.push({
        ...entry,
        installed,
        ...(version === undefined ? {} : { installedVersion: version }),
        // 索引没写版本、或已装的读不到版本时不算「可更新」：那时无从比较，
        // 而标成可更新会让人点一次更新去换一个同样的东西
        updatable:
          installed && version !== undefined && entry.version !== undefined
            ? compareVersion(entry.version, version) > 0
            : false
      })
    }
    panels.sort((a, b) => a.name.localeCompare(b.name))

    const core = await this.#core()
    return { fetchedAt: this.#fetchedAt, cached, sources: [...this.#sources], panels, readonly: core.readonly }
  }

  /**
   * 按名称取一个条目
   * @param name 包名
   * @returns 条目；索引中没有时 undefined
   */
  async entry(name: string): Promise<PanelStoreEntry | undefined> {
    await this.list()
    return this.#entries.find(item => item.name === name)
  }

  /**
   * 读内核那两项，失败时退回「不用镜像、不是只读」
   *
   * 读不到内核配置不该让商店打不开。退回值取「最不设限」的一侧：不套镜像（直连至多是慢，
   * 且失败会有明确的网络错误），不当只读（否则一次读文件失败表现为「全部按钮无故消失」）。
   * @returns 镜像前缀与只读开关
   */
  async #core(): Promise<{ mirror: string; readonly: boolean }> {
    try {
      return await this.#deps.core()
    } catch (err) {
      this.#deps.logger.debug(`读内核配置失败，按「不用镜像、不是只读」处理：${err instanceof Error ? err.message : String(err)}`)
      return { mirror: "", readonly: false }
    }
  }

  /**
   * 合并并发的索引获取
   * @param force 忽略磁盘缓存
   * @returns 获取完成
   */
  async #refresh(force: boolean): Promise<void> {
    if (this.#inflight !== undefined) return this.#inflight
    const task = this.#fetchAll(force).finally(() => {
      this.#inflight = undefined
    })
    this.#inflight = task
    return task
  }

  /**
   * 逐个索引获取并合并条目
   *
   * 同名包以靠前的索引为准，故使用者可以把私有源放在官方源之前来覆盖某个条目。
   * 全部索引都失败且没有缓存可用时，条目置空但仍记录获取时间：前端据 `sources` 展示
   * 失败原因，重试由使用者显式触发。
   * @param force 忽略磁盘缓存
   */
  async #fetchAll(force: boolean): Promise<void> {
    const { sources, timeout, cacheTtl } = this.#deps.settings()
    if (!force && this.#fetchedAt === 0) {
      const cache = await this.#loadCache()
      if (cache !== undefined && Date.now() - cache.fetchedAt < cacheTtl) {
        this.#entries = cache.entries
        this.#fetchedAt = cache.fetchedAt
        this.#sources = [{ url: this.#deps.cacheFile, ok: true, count: cache.entries.length }]
        return
      }
    }

    const { mirror } = await this.#core()
    const results: PanelStoreSourceResult[] = []
    const merged = new Map<string, PanelStoreEntry>()
    for (const url of sources) {
      try {
        const raw = await this.#deps.http.get<unknown>(applyMirror(url, mirror), {
          responseType: "json",
          timeout,
          retry: 1
        })
        const entries = parsePanelIndex(raw, url)
        for (const item of entries) if (!merged.has(item.name)) merged.set(item.name, item)
        results.push({ url, ok: true, count: entries.length })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        results.push({ url, ok: false, error, count: 0 })
        this.#deps.logger.warn(`面板插件索引获取失败 ${url}：${error}`)
      }
    }
    this.#sources = results

    if (merged.size === 0 && results.every(item => !item.ok)) {
      const cache = await this.#loadCache()
      if (cache !== undefined) {
        this.#entries = cache.entries
        this.#fetchedAt = cache.fetchedAt
        this.#deps.logger.warn("面板插件索引全部不可达，沿用上次缓存")
        return
      }
    }
    this.#entries = [...merged.values()]
    this.#fetchedAt = Date.now()
    await this.#saveCache()
  }

  /**
   * 读取磁盘缓存
   *
   * 缓存文件按不可信输入对待，重新经 `parsePanelIndex` 校验：它可能被手工改动，也可能是
   * 旧版本写下的、字段形状已不同的内容。
   * @returns 缓存内容；文件不存在或不可解析时 undefined
   */
  async #loadCache(): Promise<CacheFile | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.#deps.cacheFile, "utf8")) as unknown
      if (typeof raw !== "object" || raw === null) return undefined
      const record = raw as { fetchedAt?: unknown; entries?: unknown }
      if (typeof record.fetchedAt !== "number") return undefined
      const entries = parsePanelIndex({ panels: record.entries ?? [] }, this.#deps.cacheFile)
      return { fetchedAt: record.fetchedAt, entries }
    } catch {
      return undefined
    }
  }

  /**
   * 写入磁盘缓存
   *
   * 写入失败只记日志：缓存是加速手段，写不进去不该让一次成功的索引获取失败。
   */
  async #saveCache(): Promise<void> {
    const doc: CacheFile = { fetchedAt: this.#fetchedAt, entries: this.#entries }
    try {
      await mkdir(dirname(this.#deps.cacheFile), { recursive: true })
      await writeFile(this.#deps.cacheFile, JSON.stringify(doc, undefined, 2), "utf8")
    } catch (err) {
      this.#deps.logger.debug(`面板插件商店缓存写入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 求一个包的安装目录
   *
   * 名字先过白名单再经 `joinWithin`：越界校验挡得住 `../`，挡不住 `node_modules` 这类落在
   * 目录之内却会破事的名字。任一不通过给 undefined，由调用方拒绝。
   * @param name 包名
   * @returns 目录绝对路径；名字不合法时 undefined
   */
  #dirOf(name: string): string | undefined {
    if (!isUsableName(name)) return undefined
    try {
      return joinWithin(this.#deps.panelsDir, name)
    } catch {
      return undefined
    }
  }

  /**
   * 校验包名并求安装目录
   * @param name 包名
   * @returns 目录绝对路径
   * @throws 名字不合法时
   */
  #requireDir(name: string): string {
    const dir = this.#dirOf(name)
    if (dir === undefined) throw new Error(`面板插件名不合法：${name}`)
    return dir
  }

  /**
   * 读 package.json 里与安装相关的字段
   * @param dir 包目录
   * @returns 相关字段；无 package.json 或不可解析时 undefined
   */
  async #manifest(dir: string): Promise<PanelManifest | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown
      if (typeof raw !== "object" || raw === null) return undefined
      const record = raw as { version?: unknown; dependencies?: unknown; webuiPanel?: unknown }
      const panel = typeof record.webuiPanel === "object" && record.webuiPanel !== null ? (record.webuiPanel as Record<string, unknown>) : undefined
      const version = typeof record.version === "string" ? record.version : undefined
      const dependencies =
        typeof record.dependencies === "object" && record.dependencies !== null
          ? (record.dependencies as Record<string, string>)
          : undefined
      return {
        ...(version === undefined ? {} : { version }),
        ...(dependencies === undefined ? {} : { dependencies }),
        hasServer: typeof panel?.server === "string" && panel.server.trim() !== "",
        skipInstall: panel?.install === false
      }
    } catch {
      return undefined
    }
  }

  /**
   * 探测本机 git 可用性
   *
   * 结果缓存到进程结束。**先建出临时目录再探测**：它是这条命令的 cwd，而子进程的 cwd
   * 不存在时 execFile 报 ENOENT，那会被误记成「本机没有 git」并缓存到进程结束，此后每次
   * 安装都退回归档下载。
   * @returns git 是否可用
   */
  async #hasGit(): Promise<boolean> {
    if (this.#gitAvailable !== undefined) return this.#gitAvailable
    try {
      await mkdir(this.#deps.tempDir, { recursive: true })
      await this.#git(["--version"], this.#deps.tempDir, GIT_LOCAL_TIMEOUT_MS)
      this.#gitAvailable = true
    } catch {
      this.#gitAvailable = false
      this.#deps.logger.debug("本机未检测到 git，面板插件安装改用归档下载")
    }
    return this.#gitAvailable
  }

  /**
   * 拒绝只读模式下的写操作
   *
   * 内核的 `requireWritable()` 只拦 `/api` 之下的写请求，管不到 webui 自己 scope 里的路由，
   * 故商店的四条写路由经此自行判定，`server.readonly` 由 `coreconfig.ts` 读。
   * 文案与内核那条刻意一致：挡住使用者的是哪一侧属于实现细节，他该看到同一句话。
   * @throws 只读模式开启时
   */
  async #requireWritable(): Promise<void> {
    const core = await this.#core()
    if (core.readonly) {
      throw new Error("面板处于只读模式（配置项 server.readonly 为 true），不能执行写操作")
    }
  }

  /**
   * 装一个面板插件包
   *
   * 全过程在临时目录内完成，仅在校验通过后才移入落点，因此失败时落点保持原状。
   * 装完不加载：浏览器侧刷新页面即生效，node 侧入口要重载 webui，由返回值的 `hasServer` 区分。
   * @param name 包名
   * @param opts 可选参数
   * @param opts.replace 目标已存在时先删除再装
   * @param opts.dependencies 是否在装完后跑包管理器
   * @returns 安装结果
   * @throws 名字不合法、索引中无此包、webui 版本不满足、目标已存在或取源失败时
   */
  async install(name: string, opts: { replace?: boolean; dependencies?: boolean } = {}): Promise<PanelInstallResult> {
    await this.#requireWritable()
    const target = this.#requireDir(name)
    const entry = await this.entry(name)
    if (entry === undefined) throw new Error(`面板插件商店里没有名为 ${name} 的包`)
    const exists = await isDirectory(target)
    if (exists && opts.replace !== true) throw new Error(`面板插件 ${name} 已安装，如需覆盖请先删除`)
    this.#assertWebuiVersion(entry)

    await mkdir(this.#deps.tempDir, { recursive: true })
    const staging = await mkdtemp(join(this.#deps.tempDir, `panelstore-${name}-`))
    try {
      const { via, root } = await this.#fetch(entry, staging)
      await this.#assertLooksLikePanelPackage(root, name)
      const manifest = await this.#manifest(root)
      const version = manifest?.version ?? entry.version ?? "0.0.0"
      if (exists) await rm(target, { recursive: true, force: true })
      await mkdir(this.#deps.panelsDir, { recursive: true })
      await this.#move(root, target)
      this.#deps.logger.debug(`面板插件 ${name}@${version} 已装至 ${target}`)
      return this.#finish(name, target, via, version, manifest, opts.dependencies === true)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /**
   * 删一个面板插件包
   *
   * 只删包目录，配置留着（值存在 webui 的数据目录下），故重装同名包后原有配置仍然有效。
   * @param name 包名
   * @returns 是否确实删掉了目录
   * @throws 名字不合法或处于只读模式时
   */
  async remove(name: string): Promise<boolean> {
    await this.#requireWritable()
    const target = this.#requireDir(name)
    if (!(await isDirectory(target))) return false
    await rm(target, { recursive: true, force: true })
    this.#deps.logger.debug(`面板插件 ${name} 目录已删除：${target}`)
    return true
  }

  /**
   * 更一个面板插件包
   *
   * 目录已是 git 仓库时就地拉取，否则退回重装：重装会整目录删掉重建，而包目录里那份
   * `node_modules` 动辄几十兆。
   * @param name 包名
   * @param opts 可选参数
   * @param opts.dependencies 是否在更新后跑包管理器
   * @returns 安装结果
   */
  async update(name: string, opts: { dependencies?: boolean } = {}): Promise<PanelInstallResult> {
    await this.#requireWritable()
    const target = this.#requireDir(name)
    const pulled = await this.#tryPull(name, target, opts.dependencies === true)
    return pulled ?? this.install(name, { replace: true, ...(opts.dependencies === undefined ? {} : { dependencies: opts.dependencies }) })
  }

  /**
   * 校验 webui 版本是否满足 `minWebui`
   * @param entry 索引条目
   * @throws 不满足时
   */
  #assertWebuiVersion(entry: PanelStoreEntry): void {
    if (entry.minWebui !== undefined && compareVersion(this.#deps.webuiVersion, entry.minWebui) < 0) {
      throw new Error(
        `面板插件 ${entry.name} 要求 webui 版本不低于 ${entry.minWebui}，当前为 ${this.#deps.webuiVersion}`
      )
    }
  }

  /**
   * 试着就地拉取一个包
   *
   * 命令序列与内核 `#tryPull` 逐条一致（见 `market.ts`）：`fetch` + `reset --hard` 而非 `pull`；
   * 改动先 `stash push --include-untracked`，**顺序即安全性** —— 先 reset 后 stash 就是数据丢失；
   * fetch 的地址每次由 `applyMirror` 现算，不沿用目录里的 origin。
   *
   * 不具备条件时给 undefined 由调用方退回重装，而拉取本身失败则抛错：那时退回重装会把一次
   * 可修复的失败变成一次目录删除。
   * @param name 包名
   * @param dir 包目录
   * @param dependencies 是否跑包管理器
   * @returns 拉取结果；不具备就地拉取条件时 undefined
   * @throws 拉取过程失败时
   */
  async #tryPull(name: string, dir: string, dependencies: boolean): Promise<PanelInstallResult | undefined> {
    if (!(await isDirectory(join(dir, ".git")))) return undefined
    const entry = await this.entry(name)
    if (entry === undefined) throw new Error(`面板插件商店里没有名为 ${name} 的包`)
    if (entry.install.type !== "git") return undefined
    if (!(await this.#hasGit())) return undefined
    this.#assertWebuiVersion(entry)

    const before = (await this.#manifest(dir))?.version
    const head = async (): Promise<string> => (await this.#git(["rev-parse", "HEAD"], dir, GIT_LOCAL_TIMEOUT_MS)).trim()
    const wasAt = await head()

    const dirty = (await this.#git(["status", "--porcelain"], dir, GIT_LOCAL_TIMEOUT_MS)).trim() !== ""
    if (dirty) {
      await this.#git(
        ["stash", "push", "--include-untracked", "-m", `yunzai-ng 更新前自动暂存 ${new Date().toISOString()}`],
        dir,
        GIT_LOCAL_TIMEOUT_MS
      )
      this.#deps.logger.warn(`面板插件 ${name} 目录内有未提交的改动，已暂存。如需取回：在该目录执行 git stash pop`)
    }

    const { mirror } = await this.#core()
    const url = applyMirror(entry.install.url, mirror)
    const ref = entry.install.branch ?? "HEAD"
    await this.#git(["fetch", "--depth", "1", url, ref], dir, TRANSFER_TIMEOUT_MS)
    await this.#git(["reset", "--hard", "FETCH_HEAD"], dir, GIT_LOCAL_TIMEOUT_MS)

    const nowAt = await head()
    const changed = nowAt !== wasAt
    const manifest = await this.#manifest(dir)
    const version = manifest?.version ?? entry.version ?? "0.0.0"

    if (changed) this.#deps.logger.debug(`面板插件 ${name} 已就地更新至 ${version}（${wasAt.slice(0, 7)} → ${nowAt.slice(0, 7)}）`)
    else this.#deps.logger.debug(`面板插件 ${name} 已是最新版本 ${version}`)

    const done = await this.#finish(name, dir, "pull", version, manifest, dependencies)
    return { ...done, changed, ...(before === undefined ? {} : { fromVersion: before }) }
  }

  /**
   * 收尾：算出依赖需求，按需跑包管理器，拼出结果
   *
   * 跑包管理器要经使用者勾选，但信任边界并未因此扩大：带 node 侧的包，它的入口下一秒就会被
   * `import()` 进 node 进程跑 `setup()`，install 脚本不是一道新的门。
   *
   * 跑失败不让整次安装失败：包已装好，缺的只是依赖，向上抛会让使用者以为「什么都没装成」
   * 而去重装，重装同样会在这一步失败。故失败记进 `dependencyError` 由前端说明。
   * @param name 包名
   * @param dir 包目录
   * @param via 取源方式
   * @param version 版本
   * @param manifest package.json 里的相关字段
   * @param dependencies 是否跑包管理器
   * @returns 安装结果
   */
  async #finish(
    name: string,
    dir: string,
    via: PanelInstallVia,
    version: string,
    manifest: PanelManifest | undefined,
    dependencies: boolean
  ): Promise<PanelInstallResult> {
    const declared = Object.keys(manifest?.dependencies ?? {}).length > 0 && manifest?.skipInstall !== true
    const hasServer = manifest?.hasServer === true
    /*
     * 「声明了依赖」与「还缺依赖」是两件事
     *
     * 就地拉取那条路上目录里往往已有一份 `node_modules`，此时 declared 为真而并不缺依赖。
     * 判据取「目录里有没有 node_modules」，与内核 `market.ts` 一致 —— 「旧的够不够」要比对
     * lock 文件，本模块无从判断。
     */
    const needsDependencies = declared && !(await isDirectory(join(dir, "node_modules")))

    if (needsDependencies && dependencies) {
      try {
        const pm = await this.#install(dir)
        this.#deps.logger.debug(`面板插件 ${name} 的依赖已由 ${pm} 装好`)
        return { name, dir, via, version, needsDependencies: false, hasServer, updatable: updatableOf(via), installedDeps: true, packageManager: pm }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.#deps.logger.error(`面板插件 ${name} 的依赖安装失败：${error}。请在 ${dir} 目录内自行执行包管理器`)
        return { name, dir, via, version, needsDependencies: true, hasServer, updatable: updatableOf(via), installedDeps: false, dependencyError: error }
      }
    }

    // 声明了依赖却不缺（目录里已有 node_modules —— 就地拉取保住的那一份，或使用者自己装过）
    // 时无须出声：那正是常态，而一条「需自行安装」的警告在此处是假的
    if (needsDependencies) {
      this.#deps.logger.warn(`面板插件 ${name} 声明了运行时依赖，需在 ${dir} 目录内自行执行包管理器安装`)
    }
    return { name, dir, via, version, needsDependencies, hasServer, updatable: updatableOf(via) }
  }

  /**
   * 把包内容取到临时目录
   *
   * git 优先：克隆得到的目录带 `.git`，故此后的更新可以就地拉取（保住 `node_modules`），
   * 使用者也能自行切分支。git 不可用时退回归档下载 —— GitHub 仓库地址可换算出 codeload
   * 归档地址，其余来源若只提供 git 则明确报错，而不是静默失败。
   * @param entry 索引条目
   * @param staging 临时目录
   * @returns 取源方式与内容根目录
   * @throws git 与归档两条路都不可用，或归档为空时
   */
  async #fetch(entry: PanelStoreEntry, staging: string): Promise<{ via: PanelInstallSpec["type"]; root: string }> {
    const { mirror } = await this.#core()
    if (entry.install.type === "git" && (await this.#hasGit())) {
      const dest = join(staging, "repo")
      const args = ["clone", "--depth", "1", "--single-branch"]
      if (entry.install.branch !== undefined) args.push("--branch", entry.install.branch)
      args.push(applyMirror(entry.install.url, mirror), dest)
      await this.#git(args, staging, TRANSFER_TIMEOUT_MS)
      return { via: "git", root: dest }
    }

    const url =
      entry.install.type === "tarball" ? entry.install.url : tarballFromGit(entry.install.url, entry.install.branch)
    if (url === undefined) throw new Error(`面板插件 ${entry.name} 仅提供 git 来源，而本机未安装 git`)
    const bytes = await this.#deps.http.buffer(applyMirror(url, mirror), { timeout: TRANSFER_TIMEOUT_MS, retry: 1 })
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`归档体积 ${bytes.byteLength} 字节超过上限 ${MAX_ARCHIVE_BYTES} 字节`)
    }
    const raw = join(staging, "raw")
    const written = await extractTarGz(bytes, raw)
    if (written.length === 0) throw new Error(`归档 ${url} 中没有可写入的文件`)
    const top = singleRoot(written)
    return { via: "tarball", root: top === undefined ? raw : join(raw, top) }
  }

  /**
   * 校验取到的内容是不是一个面板插件包
   *
   * 比内核那道严一档，两个文件都要有：入口固定是包根的 `index.js`，自报信息只能写在
   * package.json 里。缺任一个，装完会被扫描器跳过或画成占位格，而原因在 node 侧的日志里。
   * @param root 内容根目录
   * @param name 包名
   * @throws 缺 package.json 或缺 index.js 时
   */
  async #assertLooksLikePanelPackage(root: string, name: string): Promise<void> {
    const hasPkg = await isFile(join(root, "package.json"))
    const hasEntry = await isFile(join(root, MULTI_ENTRY))
    if (hasPkg && hasEntry) return
    const missing = [hasPkg ? undefined : "package.json", hasEntry ? undefined : MULTI_ENTRY].filter(
      (item): item is string => item !== undefined
    )
    throw new Error(
      `取到的内容不像面板插件包：${name} 缺少 ${missing.join(" 与 ")}。` +
        `面板插件包须是「一个目录 + ${MULTI_ENTRY} + package.json」，入口固定是包根的 ${MULTI_ENTRY}`
    )
  }

  /**
   * 把临时目录里的内容移到落点
   *
   * `rename` 在跨设备时会失败（EXDEV）—— 临时目录可能在另一个分区，此时退回递归复制。
   * 复制成本高于改名，故仅作兜底。
   * @param from 源目录
   * @param to 目标目录
   */
  async #move(from: string, to: string): Promise<void> {
    try {
      await rename(from, to)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err
      await cp(from, to, { recursive: true })
    }
  }
}

/**
 * 取一个字符串字段
 * @param raw 记录
 * @param key 字段名
 * @returns 去除首尾空白后的值；类型不符或为空时 undefined
 */
function text(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * 解析安装来源
 *
 * 不认 `install.path`：子目录装法与 git 就地拉取不相容（`.git` 在仓库根，而装进落点的是
 * 子目录）。一个仓库要放多枚组件时，让那个包导出多枚，而不是切成多个安装单位。
 * @param raw 条目中的 `install` 字段
 * @returns 安装来源；字段缺失或类型不符时 undefined
 */
function parseInstall(raw: unknown): PanelInstallSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const type = text(record, "type")
  const url = text(record, "url")
  if (url === undefined) return undefined
  if (!/^https?:\/\//.test(url)) return undefined
  if (type !== "git" && type !== "tarball") return undefined
  const branch = text(record, "branch")
  return { type, url, ...(branch === undefined ? {} : { branch }) }
}

/**
 * 把一条索引记录解析为条目
 *
 * 任一必填字段不合法即返回 undefined，由调用方整条丢弃 —— 索引写错时应当表现为
 * 「该插件不出现在列表里」，而不是出现一个装不上的条目。
 * @param raw 索引记录
 * @param source 该记录所属的索引地址
 * @returns 条目；记录不合法时 undefined
 */
export function parsePanelEntry(raw: unknown, source: string): PanelStoreEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = text(record, "name")
  if (name === undefined || !isUsableName(name)) return undefined
  const install = parseInstall(record.install)
  if (install === undefined) return undefined
  const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : []
  const author = text(record, "author")
  const version = text(record, "version")
  const homepage = text(record, "homepage")
  const minWebui = text(record, "minWebui")
  // 三项预告只在类型对得上时带出；填错的数字不作废整条 —— 它不影响装不装得上
  const widgets =
    typeof record.widgets === "number" && Number.isInteger(record.widgets) && record.widgets >= 0
      ? record.widgets
      : undefined
  return {
    name,
    title: text(record, "title") ?? name,
    description: text(record, "description") ?? "",
    tags,
    official: record.official === true,
    install,
    source,
    ...(author === undefined ? {} : { author }),
    ...(version === undefined ? {} : { version }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(minWebui === undefined ? {} : { minWebui }),
    ...(widgets === undefined ? {} : { widgets }),
    ...(record.server === true ? { server: true } : {}),
    ...(record.deps === true ? { deps: true } : {})
  }
}

/**
 * 解析一份面板插件索引
 *
 * **只认 `{ panels: [...] }`。** 不认顶层数组，也不认 `{ plugins: [...] }` —— 理由见文件头：
 * 两份索引的顶层键刻意不同，放开任一种就把那道双向防线拆掉一半。
 * @param raw 已解析的 JSON
 * @param source 索引地址
 * @returns 合法条目列表
 * @throws 文档不含 `panels` 数组时
 */
export function parsePanelIndex(raw: unknown, source: string): PanelStoreEntry[] {
  const list =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { panels?: unknown }).panels)
      ? (raw as { panels: unknown[] }).panels
      : undefined
  if (list === undefined) {
    const hint = Array.isArray(raw)
      ? "顶层是数组"
      : typeof raw === "object" && raw !== null && Array.isArray((raw as { plugins?: unknown }).plugins)
        ? "顶层键是 plugins —— 那是内核插件市场的索引，填错了地方"
        : "没有 panels 数组"
    throw new Error(`面板插件索引格式不符：期望含 panels 数组的对象，实际${hint}`)
  }
  const entries: PanelStoreEntry[] = []
  for (const item of list) {
    const entry = parsePanelEntry(item, source)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}
