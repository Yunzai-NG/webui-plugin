/**
 * 模块职责：面板插件文件、自定义页面资源的取用 —— 只交出浏览器要的那几类文件
 * 依赖方向：只依赖 node 内置模块与本目录的 panelscan、themescan
 * 生命周期：无状态，每次请求现读
 * 注意事项：**不用内核的静态挂载。** 那一路不鉴权（`<script>` 与 `import()` 带不上令牌）且放行点文件，
 *          而 `plugins/<包>/` 是商店 git clone 的落点 —— `.git/config`（私有仓克隆地址常带令牌）、
 *          `node_modules`、源码与 lockfile 会对能连上面板端口的任何人敞开。这里只认扩展名白名单，
 *          且任一路径段以 `.` 开头、或是 `node_modules` 即 404。
 *
 *          另有三条：
 *          1) **node 侧代码不交出**：`package.json` 一律不给；包声明了 `webuiPanel.server` 时，那个文件
 *             与它所在的子目录不给。node 侧常读写配置、带着接口实现，浏览器用不着它们。
 *          2) **按真实路径判越界**：包内一个指向包外的符号链接，按字面路径看在包里，读到的却是包外的文件。
 *             包目录本身可以是链接（开发时 junction 进来），包里面的不行。
 *          3) **SVG 带 `sandbox` 的 CSP**：SVG 能内嵌脚本，直接打开它的地址时与面板同源、读得到令牌。
 *             当作 `<img>` 或 CSS 背景时浏览器本就不执行脚本，这个头不影响正常用法。
 */
import { realpath, stat, readFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { isSafeEntryPath, readPanelPackage } from "./panelscan.js"
import { MIME } from "./themescan.js"

/** 面板插件文件可取的类型：主题资源那份加上 json 与 map */
const PANEL_MIME: Readonly<Record<string, string>> = {
  ...MIME,
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8"
}

/** 自定义页面可取的类型：再加上页面本身 */
const PAGE_MIME: Readonly<Record<string, string>> = {
  ...PANEL_MIME,
  ".html": "text/html; charset=utf-8"
}

/** 永不交出的文件名：依赖清单与锁文件里没有浏览器要的东西 */
const HIDDEN_FILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])

/** 自定义页面目录里的 node 侧入口，见 custompage.ts */
const PAGE_NODE_ENTRIES = new Set(["index.js", "index.mjs"])

/** SVG 的内容安全策略：不许脚本、不许外链，只留内联样式 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"

/**
 * 自定义页面的内容安全策略：与面板里 iframe 的 sandbox 一致
 *
 * 页面被直接以顶层打开时也是不透明源，脚本读不到面板的 localStorage（令牌在那里）。
 */
export const PAGE_CSP = "sandbox allow-scripts allow-forms"

/** 一次取用的结果 */
export type PanelFile =
  | { readonly status: 404 }
  | {
      readonly status: 200
      readonly type: string
      readonly body: Buffer
      readonly etag: string
      /** 要附加的 `content-security-policy`；不需要时 undefined */
      readonly csp: string | undefined
    }

/**
 * 这个相对路径能不能交给浏览器
 * @param file 相对 `plugins/` 的路径
 * @param mime 可取的类型表
 * @returns 是否放行
 */
export function isServablePanelPath(file: string, mime: Readonly<Record<string, string>> = PANEL_MIME): boolean {
  if (!isSafeEntryPath(file)) return false
  const parts = file.split("/")
  if (parts.some(part => part === "" || part.startsWith(".") || part === "node_modules")) return false
  if (HIDDEN_FILES.has(parts[parts.length - 1] ?? "")) return false
  return mime[extname(file).toLowerCase()] !== undefined
}

/**
 * 读一个面板插件文件
 * @param root `plugins/` 的绝对路径
 * @param file 相对路径
 * @returns 文件内容或 404
 */
export async function readPanelFile(root: string, file: string): Promise<PanelFile> {
  if (!isServablePanelPath(file)) return { status: 404 }
  const parts = file.split("/")
  // 多文件包：首段是包目录。单文件插件就是 root 下的一个文件，没有 node 侧
  const pkgDir = parts.length > 1 ? join(root, parts[0] ?? "") : root
  if (parts.length > 1 && (await isNodeSide(pkgDir, parts.slice(1).join("/")))) return { status: 404 }
  return readWithin(pkgDir, parts.length > 1 ? parts.slice(1).join("/") : file, PANEL_MIME)
}

/**
 * 读自定义页面目录（`webadapter/`）里的一个文件
 * @param dir `webadapter/` 的绝对路径
 * @param file 相对路径
 * @returns 文件内容或 404
 */
export async function readPageFile(dir: string, file: string): Promise<PanelFile> {
  if (!isServablePanelPath(file, PAGE_MIME)) return { status: 404 }
  if (PAGE_NODE_ENTRIES.has(file)) return { status: 404 }
  return readWithin(dir, file, PAGE_MIME)
}

/**
 * 这个文件是不是包的 node 侧
 * @param pkgDir 包目录
 * @param rel 相对包目录的路径
 * @returns 是否 node 侧
 */
async function isNodeSide(pkgDir: string, rel: string): Promise<boolean> {
  const entry = (await readPanelPackage(pkgDir)).serverEntry?.replace(/^\.\//, "")
  if (entry === undefined) return false
  if (rel === entry) return true
  const folder = dirname(entry).replace(/\\/g, "/")
  // 入口在包根时只挡它自己；在子目录时整个子目录都是 node 侧
  return folder !== "." && (rel === folder || rel.startsWith(`${folder}/`))
}

/**
 * 读一个确实落在 base 里的文件
 * @param base 基准目录
 * @param rel 相对路径（已过白名单）
 * @param mime 类型表
 * @returns 文件内容或 404
 */
async function readWithin(base: string, rel: string, mime: Readonly<Record<string, string>>): Promise<PanelFile> {
  const abs = resolve(base, rel)
  if (!inside(base, abs)) return { status: 404 }
  try {
    if (!inside(await realpath(base), await realpath(abs))) return { status: 404 }
    const info = await stat(abs)
    if (!info.isFile()) return { status: 404 }
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    const type = mime[extname(rel).toLowerCase()] ?? "application/octet-stream"
    const csp = type.startsWith("image/svg") ? SVG_CSP : type.startsWith("text/html") ? PAGE_CSP : undefined
    return { status: 200, type, body: await readFile(abs), etag, csp }
  } catch {
    return { status: 404 }
  }
}

/**
 * target 是否在 base 之内（不含 base 本身）
 * @param base 基准目录
 * @param target 目标路径
 * @returns 是否在内
 */
export function inside(base: string, target: string): boolean {
  const rel = relative(base, target)
  // 跨盘符时 relative 给的是绝对路径
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
