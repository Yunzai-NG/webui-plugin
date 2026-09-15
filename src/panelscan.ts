/**
 * 模块职责：找出全部面板插件文件 —— 扫一处目录、给出待挂载的静态目录与浏览器用的清单
 * 依赖方向：只依赖 node 内置模块、类型包与本目录的 `panelconfig.ts`；不 import 内核，也不认识 Vue
 * 生命周期：`setup()` 时扫一次；清单端点每次被请求时重扫
 * 注意事项：扫描只看磁盘，不执行任何被扫到的 js —— 「这个文件导出了什么」只有浏览器 `import()`
 *          过才知道，那是 `panelcheck.ts` 的事。
 *
 *          两种形态：单文件 `<名>.js` 与包 `<名>/index.js`，包的入口固定是包根的 `index.js`。
 *
 *          包键是 `归属/首段目录名`，同时是配置文件名与商店的安装单位。node 侧的 `configKeyOf`
 *          与浏览器侧的 `packageKeyOf` 各有一份，改一处要改两处。
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { SchemaDescriptor } from "@yunzai-ng/types"
import { checkConfigSchema } from "./panelconfig.js"

/** 面板插件在 webui scope 之下的 URL 前缀 */
export const PANEL_URL_PREFIX = "pp"

/**
 * 面板插件包 node 侧路由的 URL 前缀，与静态目录的前缀刻意分开
 *
 * 静态目录挂在 `pp/<归属>` 上；若把 node 侧的路由也放进那个空间，静态处理器与路由
 * 谁先匹配就成了实现细节，而错的那一侧表现为「这个接口稳定地返回 404」。
 */
export const PANEL_API_PREFIX = "papi"

/**
 * 唯一那一路的归属名
 *
 * 只剩一处落点之后它恒为此值，但不去掉这一层：它已写进静态目录的 URL、占位格的 id 与落盘的布局，
 * 去掉等于让所有人的版面失位一次。
 */
export const PANELS_OWNER = "panels"

/** 主路的目录名，位于 webui 安装目录之下 */
const PANELS_DIR = "plugins"

/** 多文件面板插件的入口文件名 */
export const MULTI_ENTRY = "index.js"

/** webui 自身的 URL scope，与内核 `ctx.route()` / `ctx.static()` 的落点一致 */
const WEBUI_SCOPE = "/plugin/webui"

/** 可作为面板插件的扩展名 */
const PANEL_EXT = [".js", ".mjs"]

/** 归属名与文件名的合法字符；其余一律挡下，理由见文件头 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

/**
 * 一个面板插件的自报信息
 *
 * 单文件的由浏览器侧校验模块导出，多文件与插件带的由 node 侧读 package.json 填好。
 * 字段与 package.json 的常见字段同名，使多文件那一路无须另写一份格式。
 */
export interface PanelMeta {
  /** 版本号，如 `1.0.0` */
  version: string
  /** 一句话说明这个组件做什么 */
  description: string
  /** 仓库地址 */
  repository: string
  /** 作者名 */
  author: string
}

/** 一个面板插件文件 */
export interface PanelEntry {
  /** 归属，恒为 `panels`；见 `PANELS_OWNER` 为何保留这一层 */
  owner: string
  /** 文件名，如 `hardware.js`；多文件时为 `<名>/index.js` */
  file: string
  /** 浏览器 `import()` 用的地址 */
  url: string
  /** 单文件还是多文件 —— 商店按此决定 raw 下载或 git clone，也示于插件页 */
  kind: "single" | "multi"
  /**
   * node 侧已读到的自报信息；单文件那一路为 undefined，须由浏览器侧从模块导出取
   *
   * 分两处的理由见文件头：有 package.json 的地方不该再要求 js 里抄一遍。
   */
  meta?: PanelMeta
  /**
   * 该包 node 侧路由的基地址；包未声明 node 侧入口时 undefined
   *
   * 由 node 侧算出交给浏览器，理由见 `apiBaseOf`。组件经注入的 `api` 取到它，
   * 无须自己拼前缀。
   */
  api?: string
  /**
   * 这个包自带样式表的地址；未声明时 undefined
   *
   * 与 `url` 同出一处静态目录，故此处已是可直接取用的绝对路径。浏览器取到文本后要先把
   * 每条选择器限定到本包再注入（见 `web/src/panelstyle.ts`）—— 一个包的 `.card { }`
   * 若原样进全局，改的是整个面板的卡片。
   */
  style?: string
  /**
   * 样式表声明有问题的原因；没声明或声明没问题时没有此项
   *
   * 与 `configError` 同一条道理：写了却没生效的东西必须有一句话说明缘由。
   */
  styleError?: string
  /**
   * 这个包的配置：声明与当前值
   *
   * 由清单端点装配，不由 `scanPanelDir` 填：值存在 webui 的数据目录下，不在扫描的视野内。
   * schema 与值合成一项而非两个平行的可选字段 —— 两者永远同时有或同时没有。
   */
  config?: {
    /** 表单描述，来自包 package.json 的 `webuiPanel.config` */
    schema: SchemaDescriptor
    /** 当前值，已按 schema 填过默认值 */
    value: Record<string, unknown>
  }
  /**
   * 配置声明本身写坏了的原因；写对了或没声明时没有此项
   *
   * 不能只记日志：一份写坏的 `webuiPanel.config` 表现为「配置按钮没出现」，而作者刚写了它。
   */
  configError?: string
}

/** 一处待挂载的静态目录 */
export interface PanelMount {
  /** 相对 webui scope 的 URL 路径，如 `pp/panels` */
  urlPath: string
  /** 本地目录绝对路径 */
  dir: string
  /** 归属，仅用于日志 */
  owner: string
}

/** 扫描结果 */
export interface PanelScan {
  /** 待挂载的静态目录 */
  mounts: PanelMount[]
  /** 浏览器用的清单 */
  entries: PanelEntry[]
  /** 其中的多文件包 */
  packages: PanelPackage[]
}

/**
 * 主路的目录：webui 自己安装目录下的 `plugins/`
 * @param root webui 的安装目录
 * @returns 目录绝对路径
 */
export function panelsDir(root: string): string {
  return join(root, PANELS_DIR)
}

/**
 * 归属名或文件名是否可安全拼进 URL
 * @param name 待检查的名字
 * @returns 是否放行
 */
export function isSafeName(name: string): boolean {
  return name !== "." && name !== ".." && SAFE_NAME.test(name)
}

/**
 * 是否为面板插件文件
 *
 * 只认 `.js` 与 `.mjs`，不认 `.ts`：浏览器不编译它，报的语法错误指向 TypeScript 语法而非真正的问题。
 * @param file 文件名
 * @returns 是否为面板插件文件
 */
export function isPanelFile(file: string): boolean {
  return isSafeName(file) && PANEL_EXT.some(ext => file.endsWith(ext))
}

/**
 * 拼一条清单记录
 *
 * `kind` 缺省为 `single`：目录里顶层的每个 js 各自独立，即是单文件形态。
 * 只有子目录（`<名>/index.js` + package.json）才是 `multi`。
 * @param owner 归属
 * @param file 文件名；多文件时形如 `<名>/index.js`
 * @param kind 单文件还是多文件
 * @param meta node 侧已读到的自报信息；单文件那一种留空，由浏览器侧从模块导出取
 * @returns 清单记录
 */
export function entryOf(owner: string, file: string, kind: "single" | "multi" = "single", meta?: PanelMeta): PanelEntry {
  const url = `${WEBUI_SCOPE}/${PANEL_URL_PREFIX}/${owner}/${file}`
  return meta === undefined ? { owner, file, url, kind } : { owner, file, url, kind, meta }
}

/**
 * 拼一处静态挂载
 * @param owner 归属
 * @param dir 本地目录绝对路径
 * @returns 挂载记录
 */
export function mountOf(owner: string, dir: string): PanelMount {
  return { urlPath: `${PANEL_URL_PREFIX}/${owner}`, dir, owner }
}

/**
 * 一个包的 node 侧路由基地址
 *
 * 由 node 侧算出、经清单交给浏览器，不在两处各拼一遍：拼在两处会漂移，改了这边的前缀
 * 而那边仍是旧的，表现为全部包的接口一齐 404。`import()` 的 URL 同理。
 * @param pkg 包
 * @returns 形如 `/plugin/webui/papi/panels/hardware` 的地址
 */
export function apiBaseOf(pkg: PanelPackage): string {
  return `${WEBUI_SCOPE}/${PANEL_API_PREFIX}/${pkg.owner}/${pkg.name}`
}

/**
 * 一个包自带样式表的地址
 *
 * 与 `import()` 的 URL 同出那一处静态挂载（整个 `plugins/` 都挂着），故这份 css 无须
 * 另开挂载点。理由同 `apiBaseOf`：由 node 侧算出，不在浏览器侧再拼一遍。
 * @param pkg 包
 * @param file 相对包目录的样式表路径，已由 `checkStyleEntry` 查过
 * @returns 形如 `/plugin/webui/pp/panels/hardware/style.css` 的地址
 */
export function styleUrlOf(pkg: PanelPackage, file: string): string {
  return `${WEBUI_SCOPE}/${PANEL_URL_PREFIX}/${pkg.owner}/${pkg.name}/${file}`
}

/**
 * 一个路径上是不是有一个普通文件
 *
 * 不用内核那个同名函数：本模块不 import 内核（见文件头的依赖方向）。
 * @param path 绝对路径
 * @returns 是则真；不存在、是目录、或读不动时为假
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 列出一个目录下的全部文件名
 *
 * 目录不存在时给空数组而不抛错，那是常态。不在此处筛扩展名：筛掉谁要记一条警告，
 * 而那需要调用方的 `warn`，故筛选留给 `pickPanelFiles`。
 * @param dir 目录绝对路径
 * @returns 文件名数组，已排序
 */
export async function listDirFiles(dir: string): Promise<string[]> {
  try {
    const items = await readdir(dir, { withFileTypes: true })
    return items
      .filter(item => item.isFile())
      .map(item => item.name)
      .sort()
  } catch {
    // 目录不存在、或没有读权限。两者都只意味着「这里没有面板插件」
    return []
  }
}

/**
 * 从一批文件名里挑出面板插件，并为被挡下的记一条警告
 *
 * 被挡下的一律要说一句：静默跳过时使用者只看到「文件放进去了但没反应」。`.map` 与
 * `README` 一类不出声，它们本就不是想被加载的东西。
 * @param names 目录下的全部文件名
 * @param where 目录说明，写进警告里
 * @param warn 记警告
 * @returns 面板插件文件名
 */
export function pickPanelFiles(names: readonly string[], where: string, warn: (msg: string) => void): string[] {
  const out: string[] = []
  for (const name of names) {
    if (isPanelFile(name)) {
      out.push(name)
      continue
    }
    if (name.endsWith(".ts")) {
      warn(`${where} 里的 ${name} 是 TypeScript，浏览器无法执行它。面板插件须是手写的 .js / .mjs`)
      continue
    }
    // 只对「看起来就是想被当作面板插件」的文件出声
    if (PANEL_EXT.some(ext => name.endsWith(ext))) {
      warn(`${where} 里的 ${name} 文件名含不能出现在 URL 里的字符，已跳过。请改用字母、数字、. _ -`)
    }
  }
  return out
}

/**
 * 列出一个目录下的全部子目录名
 *
 * 与 `listDirFiles` 分开而非合成一个返回 Dirent 的函数：调用方要的是两份互不相干的名字表，
 * 合在一处只会让每个调用点各自再过滤一遍。
 * @param dir 目录绝对路径
 * @returns 子目录名数组，已排序
 */
export async function listDirDirs(dir: string): Promise<string[]> {
  try {
    const items = await readdir(dir, { withFileTypes: true })
    return items
      .filter(item => item.isDirectory())
      .map(item => item.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 从一个仓库地址里推出归属名
 *
 * `git+https://github.com/Yunzai-NG/hardware-plugin.git` → `Yunzai-NG`。取路径上倒数第二段：
 * GitHub、Gitee、GitLab 的 `<主机>/<归属>/<仓库>` 形状一致，SSH 写法的冒号后面也是同样两段。
 * @param repo 仓库地址
 * @returns 取得到时给出归属名，否则 undefined
 */
export function ownerFromRepo(repo: string): string | undefined {
  const parts = repo
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(part => part !== "")
  // 末段是仓库名，其前一段是归属；不足两段（形如 `./local`）则推不出
  return parts.length >= 2 ? parts[parts.length - 2] : undefined
}

/**
 * node 侧入口的相对路径是否可安全使用
 *
 * 比 `isSafeName` 宽一层，允许 `dist/server.js` 这样的子路径：TypeScript 写的包产物就在
 * `dist/` 下。仍挡住 `..`（会让包指到自己目录之外）、绝对路径与盘符写法。
 * @param path 相对包目录的路径
 * @returns 是否放行
 */
export function isSafeEntryPath(path: string): boolean {
  if (path === "" || path.includes("..") || path.startsWith("/") || path.includes(":")) return false
  return /^[A-Za-z0-9._/-]+$/.test(path)
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
 * 从一份 package.json 的文本里取自报信息
 *
 * 版本、说明、仓库三项缺一不可；`author` 缺则从仓库地址推 —— 它在 npm 里本是常缺的可选
 * 字段，拿它当门槛会让没写错什么的包变成一格红字。连 `repository` 都没有时才作废。
 *
 * `repository` 与 `author` 的字符串与对象两种写法都认：从现成项目抄一份 package.json
 * 过来是常态，为此要求改写字段没有道理。
 * @param text package.json 的内容
 * @returns 三项齐备时给出，否则 undefined
 */
export function metaFromPackageJson(text: string): PanelMeta | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(doc)) return undefined

  const record = doc
  const text_ = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

  /**
   * 取一个「字符串或对象」型字段
   * @param value 字段值
   * @param key 对象写法下该取哪个键
   * @returns 取到的文本，否则 undefined
   */
  const textOr = (value: unknown, key: string): string | undefined =>
    text_(value) ??
    (typeof value === "object" && value !== null ? text_((value as Record<string, unknown>)[key]) : undefined)

  const repo = textOr(record.repository, "url")
  const version = text_(record.version)
  const description = text_(record.description)
  if (version === undefined || description === undefined || repo === undefined) return undefined

  const author = textOr(record.author, "name") ?? ownerFromRepo(repo)
  if (author === undefined) return undefined

  return { version, description, repository: repo, author }
}

/**
 * 一个面板插件包的 package.json 里与 webui 有关的全部内容
 *
 * 自报信息之外的几项只有包才可能有：node 侧入口、依赖需求、配置声明与样式表。单文件那一路
 * 跑在浏览器里，既没有 node 侧也没有 `node_modules`；配置的 schema 与样式表的路径都须由
 * node 侧读得到，而它没有一份 node 读得到的声明（见 `panelconfig.ts` 文件头）。
 */
export interface PanelPackageInfo {
  /** 自报信息；三项必需字段不全时 undefined */
  meta?: PanelMeta
  /** node 侧入口的文件名，相对包目录；未声明时 undefined */
  serverEntry?: string
  /** 装这个包之后是否须跑一次包管理器 */
  needsInstall: boolean
  /** 配置表单的声明；未声明或写坏了时 undefined */
  config?: SchemaDescriptor
  /** 声明写坏了的原因；写对了或没声明时 undefined */
  configError?: string
  /** 样式表的文件名，相对包目录；未声明或路径不合法时 undefined */
  styleEntry?: string
  /** 样式表声明有问题的原因；没声明或没问题时 undefined */
  styleError?: string
}

/**
 * 校验 `webuiPanel.style` 的声明
 *
 * 只认 `.css`：一个 `.scss` 或 `.less` 浏览器不会编译，`<link>` 上去得到的是一份被当作
 * 样式表的源码，表现为「样式全没生效」而不报错。
 *
 * 写坏时给出原因而非静默丢弃，同 `webuiPanel.config` —— 作者刚写下的东西没生效，
 * 总得有一句话说明缘由。存在性不在此处查：本函数是纯的。
 * @param value `webuiPanel.style` 的原值
 * @returns 合法时给出路径，否则给出一句原因
 */
export function checkStyleEntry(value: unknown): { ok: true; file: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "webuiPanel.style 须是一个字符串，即包内那份 .css 的相对路径" }
  if (!isSafeEntryPath(value)) {
    return { ok: false, reason: `webuiPanel.style 的路径 ${value} 不可用：须是包内的相对路径，不能含 .. 或盘符` }
  }
  if (!value.endsWith(".css")) {
    return { ok: false, reason: `webuiPanel.style 指向的 ${value} 不是 .css；浏览器不编译 scss / less，须给出构建好的 css` }
  }
  return { ok: true, file: value }
}

/**
 * 从一份 package.json 的文本里取出 webui 关心的几件事
 *
 * `needsInstall` 由 `dependencies` 是否非空判定，不另立字段：多一处声明就多一处能与
 * `dependencies` 打架的事实，而打架时的后果是运行期「找不到模块」，离声明很远。逃生口是
 * `webuiPanel.install: false` —— 包已把依赖打进产物时由它自己说了算。
 *
 * node 侧入口与样式表只取路径，不查存在性：本函数是纯的，碰磁盘的判断留给调用方。
 *
 * 配置与样式声明写坏时给出原因而非静默丢弃：作者刚写下的东西没生效，总得有一句话说明缘由。
 * @param text package.json 的内容
 * @returns webui 关心的几件事；解析不了时给出「什么都没有」而非抛错
 */
export function packageInfoFrom(text: string): PanelPackageInfo {
  const meta = metaFromPackageJson(text)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return meta === undefined ? { needsInstall: false } : { meta, needsInstall: false }
  }
  if (!isRecord(doc)) return meta === undefined ? { needsInstall: false } : { meta, needsInstall: false }

  const panel = isRecord(doc.webuiPanel) ? doc.webuiPanel : undefined
  const entry = typeof panel?.server === "string" && isSafeEntryPath(panel.server) ? panel.server : undefined
  const deps = isRecord(doc.dependencies) ? Object.keys(doc.dependencies).length > 0 : false
  const needsInstall = panel?.install === false ? false : deps
  const config = panel?.config === undefined ? undefined : checkConfigSchema(panel.config)
  const style = panel?.style === undefined ? undefined : checkStyleEntry(panel.style)

  return {
    ...(meta === undefined ? {} : { meta }),
    ...(entry === undefined ? {} : { serverEntry: entry }),
    needsInstall,
    ...(config === undefined || !config.ok ? {} : { config: config.schema }),
    ...(config === undefined || config.ok ? {} : { configError: config.reason }),
    ...(style === undefined || !style.ok ? {} : { styleEntry: style.file }),
    ...(style === undefined || style.ok ? {} : { styleError: style.reason })
  }
}

/**
 * 读一个面板插件包的 package.json
 * @param dir 包目录绝对路径
 * @returns webui 关心的三件事；文件不存在或读不动时给出「什么都没有」
 */
export async function readPanelPackage(dir: string): Promise<PanelPackageInfo> {
  try {
    return packageInfoFrom(await readFile(join(dir, "package.json"), "utf8"))
  } catch {
    return { needsInstall: false }
  }
}

/**
 * 一个多文件面板插件包
 *
 * 与 `PanelEntry` 是两回事：那是「浏览器要 `import()` 的一个文件」，这是「磁盘上的一个
 * 目录」。node 侧入口与依赖需求只有包才可能有，故记在包上而非每条 entry 上。
 */
export interface PanelPackage {
  /** 归属，恒为 `panels`；见 `PANELS_OWNER` */
  owner: string
  /** 包名，即目录名 */
  name: string
  /** 包目录绝对路径 */
  dir: string
  /** 自报信息；缺失时 undefined，由浏览器侧画占位格 */
  meta?: PanelMeta
  /** node 侧入口文件名；未声明时 undefined */
  serverEntry?: string
  /** 装完是否须跑一次包管理器；商店据此决定 */
  needsInstall: boolean
  /** 配置表单的声明；未声明或写坏了时 undefined */
  config?: SchemaDescriptor
  /** 配置声明写坏了的原因；经清单交给浏览器，见 `PanelEntry.configError` */
  configError?: string
  /** 自带样式表的文件名，相对包目录；未声明或路径不合法时 undefined */
  styleEntry?: string
  /** 样式表声明有问题的原因；经清单交给浏览器，见 `PanelEntry.styleError` */
  styleError?: string
}

/** 扫一个面板目录的结果 */
export interface PanelDirScan {
  /** 清单项 */
  entries: PanelEntry[]
  /** 其中的多文件包 */
  packages: PanelPackage[]
}

/**
 * 扫一处面板目录：顶层的 `<名>.js` 是单文件，顶层的 `<名>/index.js` 是多文件包
 *
 * 子目录缺 `index.js` 时记一条警告。缺 package.json 或字段不全的**仍进清单**，
 * 带着 `meta: undefined`，由浏览器侧统一画占位格 —— 在 node 侧丢掉它只留一条日志，
 * 使用者什么都看不到。
 * @param owner 归属名
 * @param dir 目录绝对路径
 * @param warn 记一条警告
 * @returns 清单项与包
 */
export async function scanPanelDir(
  owner: string,
  dir: string,
  warn: (msg: string) => void
): Promise<PanelDirScan> {
  const entries: PanelEntry[] = []
  const packages: PanelPackage[] = []

  for (const file of pickPanelFiles(await listDirFiles(dir), dir, warn)) {
    // 顶层的 package.json 不参与：它是「这个目录自己的」而非某个插件的
    entries.push(entryOf(owner, file, "single"))
  }

  for (const name of await listDirDirs(dir)) {
    if (!isSafeName(name)) {
      warn(`${dir} 里的 ${name} 目录名含不能出现在 URL 里的字符，已跳过。请改用字母、数字、. _ -`)
      continue
    }
    const sub = join(dir, name)
    const files = await listDirFiles(sub)
    if (!files.includes(MULTI_ENTRY)) {
      warn(`${sub} 缺少入口文件 ${MULTI_ENTRY}，已跳过。多文件面板插件的入口须是 ${MULTI_ENTRY}`)
      continue
    }
    const info = await readPanelPackage(sub)
    if (info.configError !== undefined) {
      warn(`${sub} 的 package.json 里 ${info.configError}，本包此次没有可配置项`)
    }

    /*
     * 声明了样式表却没有那个文件：在此判，不留给浏览器
     *
     * 不判的话浏览器取到的是静态目录的 404 页，那份 HTML 会被当成 css 送进限定与注入，
     * 结果是「样式没生效」而控制台一句话都没有。而作者要做的只是改一个路径。
     */
    let styleEntry = info.styleEntry
    let styleError = info.styleError
    if (styleEntry !== undefined && !(await isFile(join(sub, styleEntry)))) {
      styleError = `webuiPanel.style 指向的 ${styleEntry} 不存在，本包此次没有自带样式`
      styleEntry = undefined
    }
    if (styleError !== undefined) warn(`${sub}：${styleError}`)

    const pkg: PanelPackage = {
      owner,
      name,
      dir: sub,
      ...(info.meta === undefined ? {} : { meta: info.meta }),
      ...(info.serverEntry === undefined ? {} : { serverEntry: info.serverEntry }),
      needsInstall: info.needsInstall,
      ...(info.config === undefined ? {} : { config: info.config }),
      ...(info.configError === undefined ? {} : { configError: info.configError }),
      ...(styleEntry === undefined ? {} : { styleEntry }),
      ...(styleError === undefined ? {} : { styleError })
    }
    packages.push(pkg)
    entries.push({
      ...entryOf(owner, `${name}/${MULTI_ENTRY}`, "multi", info.meta),
      ...(info.serverEntry === undefined ? {} : { api: apiBaseOf(pkg) }),
      ...(styleEntry === undefined ? {} : { style: styleUrlOf(pkg, styleEntry) }),
      ...(styleError === undefined ? {} : { styleError })
    })
  }

  return { entries, packages }
}

/** 主路扫描的结果：待挂载的目录与清单项 */
export interface PanelsDirScan {
  /** 待挂载的静态目录；主路只挂一处（整个 `plugins/`），子目录随之可取 */
  mount: PanelMount
  /** 清单项 */
  entries: PanelEntry[]
  /** 其中的多文件包 */
  packages: PanelPackage[]
}

/**
 * 扫主路：webui 安装目录下的 `plugins/`
 *
 * **只挂一处静态目录**（整个 `plugins/`），故多文件插件的相对 import 与它的 `lib/`
 * 一并可取。形态两种、缺入口与缺 meta 的处置见 `scanPanelDir`。
 * @param root webui 的安装目录
 * @param warn 记一条警告
 * @returns 待挂载的目录、清单项与包
 */
export async function scanPanelsDir(root: string, warn: (msg: string) => void): Promise<PanelsDirScan> {
  const dir = panelsDir(root)
  const scan = await scanPanelDir(PANELS_OWNER, dir, warn)
  return { mount: mountOf(PANELS_OWNER, dir), entries: scan.entries, packages: scan.packages }
}

/** 扫描所需的外部事实 */
export interface ScanDeps {
  /**
   * webui 自己的安装目录；唯一那一路的 `plugins/` 即在其下
   *
   * 取不到时（测试里不给、或内核未提供）给出空清单，但**仍给出挂载** —— 目录恒被挂载，
   * 使用者放进第一个文件后刷新页面即可，不必重载插件。
   */
  webuiRoot?: string
  /**
   * 记一条警告
   * @param msg 内容
   */
  warn: (msg: string) => void
}

/**
 * 扫出全部面板插件
 *
 * 目录恒被挂载，即使此刻空无一物或 `webuiRoot` 取不到 —— 使用者放进第一个文件后只需刷新
 * 页面，不必重载插件。保留本函数这一层是因为它是 `index.ts` 唯一认识的入口，且挂载恒定
 * 这条规则须落在一处。
 * @param deps 外部事实
 * @returns 待挂载的目录、浏览器用的清单与其中的包
 */
export async function scanPanels(deps: ScanDeps): Promise<PanelScan> {
  if (deps.webuiRoot === undefined || deps.webuiRoot === "") {
    return { mounts: [], entries: [], packages: [] }
  }

  const scan = await scanPanelsDir(deps.webuiRoot, deps.warn)
  return { mounts: [scan.mount], entries: scan.entries, packages: scan.packages }
}
