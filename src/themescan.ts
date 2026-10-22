/**
 * 模块职责：主题 —— 找出全部主题包、校验清单、给出浏览器用的主题表，并处理主题样式表
 * 依赖方向：只依赖 node 内置模块与本目录的 panelscan（借它的路径校验）；不 import 内核，也不认识 Vue
 * 生命周期：主题表端点每次被请求时重扫；样式表与资源每次请求时现读
 * 注意事项：**主题从两处来**：webui 自带的 `themes/<id>/`（经典与 YUNZAI NG），以及面板商店装进
 *          `plugins/<包>/` 的包 —— 后者在 package.json 里写 `webuiTheme`。两处同一套清单格式，
 *          内置的不走捷径：机制若对自己都不够用，对别人也不会够用。
 *
 *          **id 全局唯一，先到先得，内置优先。** 一个第三方包自称 `classic` 时被跳过并警告 ——
 *          否则装一个包就能顶替兜底层。
 *
 *          **样式表的 `url()` 只能指向包内。** 外站地址一律换成 `none` 并警告：面板写明了不向公网
 *          发请求；外站 `url()` 还能被用来回传「页面上有哪些元素」（按选择器挂不同的背景图）。
 *          `data:` 放行，它不发请求。整份样式表包进 `@layer theme`，于是主题盖得过面板默认样式、
 *          又盖不过面板插件在自己地盘里的样式，与注入先后无关（层的次序见 web/index.html）。
 *
 *          **资源路由不要令牌、带 `Access-Control-Allow-Origin: *`。** `<link>` 与 `<img>` 带不上令牌；
 *          扩展页的 iframe 是不透明源，跨源取字体要这个头。主题资源本就是公开的静态文件，
 *          与 `pp/` 下的面板插件文件同一待遇。
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative, resolve, sep } from "node:path"
import { isSafeEntryPath, isSafeName, panelsDir } from "./panelscan.js"

/** 内置主题所在目录，位于 webui 安装目录之下 */
const BUILTIN_DIR = "themes"

/** webui 自身的 URL scope */
const WEBUI_SCOPE = "/plugin/webui"

/** 主题表端点，不含前导斜杠 */
export const THEMES_ENDPOINT = "themes.json"

/** 主题资源的 URL 前缀，不含前导斜杠；形如 `theme/<id>/<文件>` */
export const THEME_ASSET_PREFIX = "theme"

/** 新装默认、也是兜底的主题 */
export const CLASSIC_ID = "classic"

/** 主题 id 的合法字符：小写开头，可含数字与 `. _ -`；与浏览器侧 appearance.ts 一致 */
const THEME_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** 可作为主题资源的扩展名及其类型 */
const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf"
}

/** 图片类扩展名：槽位、预览、图标只收这些 */
const IMAGE_EXT = new Set([".png", ".webp", ".avif", ".gif", ".jpg", ".jpeg", ".svg"])

/**
 * 公开的槽位
 *
 * 成文进 docs，加了就不改名。每一项在面板里都有一个固定的落点，见 web/src/themes.ts 的 `SLOT_VARS`。
 */
export const SLOTS = [
  "brand.mark",
  "brand.lockup",
  "frame.card",
  "frame.widget",
  "switch.thumb.on",
  "switch.thumb.off",
  "empty",
  "loading",
  "login.art",
  "backdrop"
] as const

/** 槽位名 */
export type SlotName = (typeof SLOTS)[number]

/** 可整套换图标的导航项，与 web/src/router.ts 的 `ROUTES` 一致 */
export const NAV_IDS = [
  "overview",
  "accounts",
  "logs",
  "storage",
  "plugins",
  "custom",
  "market",
  "store",
  "config",
  "help",
  "appearance"
] as const

/** 九宫格边框：图、切片、宽度 */
export interface FrameSlot {
  /** 图片地址（已解析为绝对 URL） */
  readonly image: string
  /** `border-image-slice`，像素 */
  readonly slice: number
  /** 边框宽度，CSS 长度 */
  readonly width: string
  /** 向外扩出多少，CSS 长度 */
  readonly outset: string
  /** `border-image-repeat` */
  readonly repeat: "stretch" | "repeat" | "round" | "space"
}

/** 一个槽位解析后的值 */
export type SlotValue = string | FrameSlot | { readonly light?: string; readonly dark?: string }

/** 主题允许使用者改的项 */
export interface ThemeOptions {
  /** 强调色 */
  readonly accentHue: boolean
  /** 圆角 */
  readonly radius: boolean
  /** 背景 */
  readonly backdrop: boolean
}

/** 背景档位 */
export type Backdrop = "gradient" | "dots" | "plain" | "image"

/** 浏览器用的一条主题记录 */
export interface ThemeInfo {
  /** 主题 id */
  readonly id: string
  /** 显示名 */
  readonly name: string
  /** 一句话说明 */
  readonly description: string
  /** 作者 */
  readonly author: string
  /** 版本 */
  readonly version: string
  /** 授权说明 */
  readonly license: string
  /** 支持的明暗 */
  readonly schemes: readonly ("light" | "dark")[]
  /** 是否为 webui 自带 */
  readonly builtin: boolean
  /** 来自哪个包（商店装的那些）；内置的没有 */
  readonly pkg?: string
  /** 样式表地址；经典没有 */
  readonly style?: string
  /** 脚本地址；没有时省略 */
  readonly script?: string
  /** 预览图地址 */
  readonly preview?: string
  /** 图标：描边线稿或彩色图片 */
  readonly icons?: { readonly mode: "stroke" | "image"; readonly nav: Readonly<Record<string, string>> }
  /** 已解析的槽位 */
  readonly slots: Readonly<Partial<Record<SlotName, SlotValue>>>
  /** 允许改的项 */
  readonly options: ThemeOptions
  /** 主题自己的缺省背景 */
  readonly backdrop: Backdrop
}

/** 一份通过了校验的清单：路径仍是相对包目录的 */
export interface ThemeManifest {
  /** 主题 id */
  readonly id: string
  /** 显示名 */
  readonly name: string
  /** 一句话说明 */
  readonly description: string
  /** 授权说明 */
  readonly license: string
  /** 支持的明暗 */
  readonly schemes: readonly ("light" | "dark")[]
  /** 样式表，相对包目录 */
  readonly style?: string
  /** 脚本，相对包目录 */
  readonly script?: string
  /** 预览图，相对包目录 */
  readonly preview?: string
  /** 图标 */
  readonly icons?: { readonly mode: "stroke" | "image"; readonly nav: Readonly<Record<string, string>> }
  /** 槽位，图片路径相对包目录 */
  readonly slots: Readonly<Partial<Record<SlotName, SlotValue>>>
  /** 允许改的项 */
  readonly options: ThemeOptions
  /** 缺省背景 */
  readonly backdrop: Backdrop
}

/** 清单校验的结果 */
export type ManifestCheck =
  | { readonly ok: true; readonly manifest: ThemeManifest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * 是不是一个普通对象
 * @param value 任意值
 * @returns 是否为对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 主题 id 是否可用
 * @param id 待查的 id
 * @returns 是否放行
 */
export function isSafeThemeId(id: string): boolean {
  return THEME_ID.test(id)
}

/**
 * 包内的一个图片路径是否可用
 * @param value 原值
 * @returns 合法时给出路径
 */
function imagePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !isSafeEntryPath(value)) return undefined
  return IMAGE_EXT.has(extname(value).toLowerCase()) ? value : undefined
}

/** 一段 svg path 数据只许出现的字符：命令字母、数字、空白与 `. , -` */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]{1,2000}$/

/**
 * 校验一个槽位
 * @param name 槽位名
 * @param raw 原值
 * @returns 合法时给出值，否则 undefined
 */
function checkSlot(name: SlotName, raw: unknown): SlotValue | undefined {
  if (name === "frame.card" || name === "frame.widget") {
    if (!isRecord(raw)) return undefined
    const image = imagePath(raw.image)
    const slice = typeof raw.slice === "number" && raw.slice > 0 && raw.slice < 1000 ? Math.round(raw.slice) : undefined
    if (image === undefined || slice === undefined) return undefined
    const len = (v: unknown, fallback: string): string =>
      typeof v === "string" && /^\d+(\.\d+)?(px|rem|em)$/.test(v) ? v : fallback
    const repeat = raw.repeat === "repeat" || raw.repeat === "round" || raw.repeat === "space" ? raw.repeat : "stretch"
    return { image, slice, width: len(raw.width, `${slice / 2}px`), outset: len(raw.outset, "0px"), repeat }
  }
  // 图片槽位都可以分明暗给两张（深色底上的字标要换白字版）
  if (isRecord(raw)) {
    const light = imagePath(raw.light)
    const dark = imagePath(raw.dark)
    if (light === undefined && dark === undefined) return undefined
    return { ...(light === undefined ? {} : { light }), ...(dark === undefined ? {} : { dark }) }
  }
  return imagePath(raw)
}

/**
 * 校验一份 `webuiTheme` 清单
 *
 * 必填只有 `id` 与 `name`：缺了它们，主题在外观页上既叫不出名字也选不中。其余项写坏时
 * 丢掉那一项并给一句警告，不作废整款主题 —— 一张边框图路径写错不该让整套皮肤不见。
 * 文件存不存在不在此处查：本函数是纯的。
 * @param raw `webuiTheme` 的原值
 * @returns 校验结果
 */
export function checkThemeManifest(raw: unknown): ManifestCheck {
  if (!isRecord(raw)) return { ok: false, reason: "webuiTheme 须是一个对象" }
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  if (!isSafeThemeId(id)) {
    return { ok: false, reason: `webuiTheme.id「${id}」不可用：须是小写字母或数字开头，只含 a-z 0-9 . _ -，不超过 64 个字符` }
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (name === "") return { ok: false, reason: "webuiTheme.name 不能为空：它是外观页上显示的主题名" }

  const warnings: string[] = []
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

  const schemes = Array.isArray(raw.schemes)
    ? [...new Set(raw.schemes.filter((s): s is "light" | "dark" => s === "light" || s === "dark"))]
    : []
  if (Array.isArray(raw.schemes) && schemes.length === 0) warnings.push("webuiTheme.schemes 里没有认得的取值（light / dark），按两套都支持算")

  /**
   * 一个包内文件的路径
   * @param key 字段名
   * @param exts 允许的扩展名
   * @returns 合法时给出路径
   */
  const file = (key: string, exts: readonly string[]): string | undefined => {
    const v = raw[key]
    if (v === undefined) return undefined
    if (typeof v !== "string" || !isSafeEntryPath(v) || !exts.includes(extname(v).toLowerCase())) {
      warnings.push(`webuiTheme.${key} 须是包内的相对路径（${exts.join(" / ")}），已忽略`)
      return undefined
    }
    return v
  }
  const style = file("style", [".css"])
  const script = file("script", [".js", ".mjs"])
  const preview = raw.preview === undefined ? undefined : imagePath(raw.preview)
  if (raw.preview !== undefined && preview === undefined) warnings.push("webuiTheme.preview 须是包内的图片，已忽略")

  let icons: ThemeManifest["icons"]
  if (isRecord(raw.icons)) {
    const mode = raw.icons.mode === "image" ? "image" : "stroke"
    const nav: Record<string, string> = {}
    if (isRecord(raw.icons.nav)) {
      for (const [key, value] of Object.entries(raw.icons.nav)) {
        if (!(NAV_IDS as readonly string[]).includes(key)) {
          warnings.push(`webuiTheme.icons.nav.${key} 不是可换图标的导航项，已忽略`)
          continue
        }
        const ok = mode === "image" ? imagePath(value) : typeof value === "string" && PATH_DATA.test(value) ? value : undefined
        if (ok === undefined) warnings.push(`webuiTheme.icons.nav.${key} 写坏了（${mode === "image" ? "须是包内图片" : "须是 svg path 数据"}），已忽略`)
        else nav[key] = ok
      }
    }
    icons = { mode, nav }
  }

  const slots: Partial<Record<SlotName, SlotValue>> = {}
  if (isRecord(raw.slots)) {
    for (const [key, value] of Object.entries(raw.slots)) {
      if (!(SLOTS as readonly string[]).includes(key)) {
        warnings.push(`webuiTheme.slots.${key} 不是公开的槽位，已忽略`)
        continue
      }
      const ok = checkSlot(key as SlotName, value)
      if (ok === undefined) warnings.push(`webuiTheme.slots.${key} 写坏了，已忽略`)
      else slots[key as SlotName] = ok
    }
  }

  const opt = isRecord(raw.options) ? raw.options : {}
  const options: ThemeOptions = {
    accentHue: opt.accentHue !== false,
    radius: opt.radius !== false,
    backdrop: opt.backdrop !== false
  }
  const backdrop: Backdrop =
    raw.backdrop === "dots" || raw.backdrop === "plain" || raw.backdrop === "image" ? raw.backdrop : "gradient"

  return {
    ok: true,
    warnings,
    manifest: {
      id,
      name,
      description: text(raw.description),
      license: text(raw.license),
      schemes,
      ...(style === undefined ? {} : { style }),
      ...(script === undefined ? {} : { script }),
      ...(preview === undefined ? {} : { preview }),
      ...(icons === undefined ? {} : { icons }),
      slots,
      options,
      backdrop
    }
  }
}

/**
 * 一款主题资源的 URL 前缀
 * @param id 主题 id
 * @returns 形如 `/plugin/webui/theme/pumpkin`
 */
export function themeBaseOf(id: string): string {
  return `${WEBUI_SCOPE}/${THEME_ASSET_PREFIX}/${id}`
}

/**
 * 把清单里相对包目录的路径解析成浏览器可取的地址
 * @param manifest 通过了校验的清单
 * @param meta 包自己的作者与版本、是否内置、所属包名
 * @returns 浏览器用的主题记录
 */
export function resolveTheme(
  manifest: ThemeManifest,
  meta: { author: string; version: string; builtin: boolean; pkg?: string }
): ThemeInfo {
  const base = themeBaseOf(manifest.id)
  const url = (path: string): string => `${base}/${path}`
  const slots: Partial<Record<SlotName, SlotValue>> = {}
  for (const [key, value] of Object.entries(manifest.slots) as [SlotName, SlotValue][]) {
    if (typeof value === "string") slots[key] = url(value)
    else if ("image" in value) slots[key] = { ...value, image: url(value.image) }
    else slots[key] = { ...(value.light === undefined ? {} : { light: url(value.light) }), ...(value.dark === undefined ? {} : { dark: url(value.dark) }) }
  }
  const icons =
    manifest.icons === undefined
      ? undefined
      : {
          mode: manifest.icons.mode,
          nav: Object.fromEntries(
            Object.entries(manifest.icons.nav).map(([k, v]) => [k, manifest.icons?.mode === "image" ? url(v) : v])
          )
        }
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    author: meta.author,
    version: meta.version,
    license: manifest.license,
    schemes: manifest.schemes,
    builtin: meta.builtin,
    ...(meta.pkg === undefined ? {} : { pkg: meta.pkg }),
    ...(manifest.style === undefined ? {} : { style: url(manifest.style) }),
    ...(manifest.script === undefined ? {} : { script: url(manifest.script) }),
    ...(manifest.preview === undefined ? {} : { preview: url(manifest.preview) }),
    ...(icons === undefined ? {} : { icons }),
    slots,
    options: manifest.options,
    backdrop: manifest.backdrop
  }
}

/** 一条扫描结果：主题记录与它所在的目录 */
export interface ScannedTheme {
  /** 浏览器用的主题记录 */
  readonly info: ThemeInfo
  /** 包目录绝对路径，资源路由据它取文件 */
  readonly dir: string
}

/**
 * 读一个目录的 package.json，取出主题清单与作者、版本
 * @param dir 包目录
 * @returns 有 `webuiTheme` 时给出原值与作者、版本；没有时 undefined
 */
async function readThemePackage(dir: string): Promise<{ raw: unknown; author: string; version: string } | undefined> {
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(doc) || doc.webuiTheme === undefined) return undefined
  const author =
    typeof doc.author === "string" ? doc.author : isRecord(doc.author) && typeof doc.author.name === "string" ? doc.author.name : ""
  return { raw: doc.webuiTheme, author, version: typeof doc.version === "string" ? doc.version : "" }
}

/**
 * 列出一个目录下的子目录名
 *
 * 链接过来的目录（Windows 的目录联接、符号链接）也算：开发时把一个包链进 `plugins/` 是常态，
 * 而 `Dirent.isDirectory()` 对它们给的是假。
 * @param dir 目录
 * @returns 子目录名，已排序；目录不存在时空数组
 */
async function subdirs(dir: string): Promise<string[]> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const item of items) {
    if (!isSafeName(item.name)) continue
    if (item.isDirectory()) out.push(item.name)
    else if (item.isSymbolicLink()) {
      try {
        if ((await stat(join(dir, item.name))).isDirectory()) out.push(item.name)
      } catch {
        // 断掉的链接：当作没有
      }
    }
  }
  return out.sort()
}

/**
 * 一个路径上是不是有一个普通文件
 * @param path 绝对路径
 * @returns 是则真
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 扫出全部主题
 *
 * 内置的先扫、经典排第一；商店装的随后，同 id 的后来者被跳过。清单写坏的整款跳过并警告；
 * 写坏的单项已在 `checkThemeManifest` 里丢掉。声明了却不存在的样式表与脚本在此判：
 * 不判的话浏览器取到的是 404，表现为「换了主题没变化」而控制台一句话都没有。
 * @param webuiRoot webui 安装目录
 * @param warn 记一条警告
 * @returns 主题表
 */
export async function scanThemes(webuiRoot: string, warn: (msg: string) => void): Promise<ScannedTheme[]> {
  const out: ScannedTheme[] = []
  const seen = new Set<string>()
  const sources: { dir: string; builtin: boolean; pkg?: string }[] = []
  const builtinRoot = join(webuiRoot, BUILTIN_DIR)
  const builtins = await subdirs(builtinRoot)
  // 经典排第一：外观页的第一张卡片就是兜底那一款
  builtins.sort((a, b) => (a === CLASSIC_ID ? -1 : b === CLASSIC_ID ? 1 : a.localeCompare(b)))
  for (const name of builtins) sources.push({ dir: join(builtinRoot, name), builtin: true })
  for (const name of await subdirs(panelsDir(webuiRoot))) sources.push({ dir: join(panelsDir(webuiRoot), name), builtin: false, pkg: name })

  for (const src of sources) {
    const pkg = await readThemePackage(src.dir)
    if (pkg === undefined) continue
    const check = checkThemeManifest(pkg.raw)
    if (!check.ok) {
      warn(`${src.dir}：${check.reason}，这款主题已跳过`)
      continue
    }
    for (const w of check.warnings) warn(`${src.dir}：${w}`)
    let manifest = check.manifest
    if (seen.has(manifest.id)) {
      warn(`${src.dir}：主题 id「${manifest.id}」已被${manifest.id === CLASSIC_ID ? "内置的经典主题" : "另一款主题"}占用，这款已跳过`)
      continue
    }
    for (const key of ["style", "script"] as const) {
      const path = manifest[key]
      if (path !== undefined && !(await isFile(join(src.dir, path)))) {
        warn(`${src.dir}：webuiTheme.${key} 指向的 ${path} 不存在，已忽略`)
        const { [key]: _drop, ...rest } = manifest
        manifest = rest
      }
    }
    seen.add(manifest.id)
    out.push({
      info: resolveTheme(manifest, { author: pkg.author, version: pkg.version, builtin: src.builtin, ...(src.pkg === undefined ? {} : { pkg: src.pkg }) }),
      dir: src.dir
    })
  }
  return out
}

/**
 * 把包内一个相对路径拼到另一个相对路径上，并拦住走出包外的
 * @param from 引用者所在的路径（相对包目录），如 `css/theme.css`
 * @param ref 引用的路径，如 `../art/frame.png`
 * @returns 相对包目录的结果；走出包外时 undefined
 */
function joinInside(from: string, ref: string): string | undefined {
  const parts = from.split("/").slice(0, -1)
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(seg)
  }
  const out = parts.join("/")
  return out !== "" && isSafeEntryPath(out) ? out : undefined
}

/** `url(...)` 的三种写法：双引号、单引号、不带引号 */
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi

/** 打头的 `@charset` / `@import` 语句：它们须在任何规则之前，不能进 `@layer` 块 */
const LEADING_AT = /^\s*@(charset|import)\b[^;]*;/i

/**
 * 处理一份主题样式表：`url()` 收进包内、外站一律剔除、整份包进 `@layer theme`
 *
 * 只对主题声明的那一份入口样式表做，它 `@import` 进来的其余文件只做 `url()` 那一半 ——
 * 再包一层就成了 `theme.theme`，与面板插件那一层的先后对不上。
 * @param css 原文
 * @param file 这份样式表相对包目录的路径
 * @param base 主题资源的 URL 前缀，见 `themeBaseOf`
 * @param wrap 是否包进 `@layer theme`
 * @returns 处理后的文本与警告
 */
export function processThemeCss(css: string, file: string, base: string, wrap: boolean): { css: string; warnings: string[] } {
  const warnings: string[] = []
  /**
   * 换写一个地址
   * @param raw 原地址
   * @returns 换写后的 `url(...)`
   */
  const rewrite = (raw: string): string => {
    const ref = raw.trim()
    if (ref === "" || ref.startsWith("#")) return `url("${ref}")`
    if (/^data:/i.test(ref)) return `url("${ref.replace(/"/g, "%22")}")`
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref) || ref.startsWith("/")) {
      warnings.push(`${file} 引用了包外的 ${ref.slice(0, 80)}，已剔除：主题只能用包内的文件`)
      return "none"
    }
    const [path, tail = ""] = ref.split(/(?=[?#])/)
    const inside = joinInside(file, path ?? "")
    if (inside === undefined) {
      warnings.push(`${file} 引用的 ${ref.slice(0, 80)} 走出了主题包，已剔除`)
      return "none"
    }
    return `url("${base}/${inside}${tail}")`
  }

  let body = css
  const head: string[] = []
  for (;;) {
    const m = LEADING_AT.exec(body)
    if (m === null) break
    const stmt = m[0].trim()
    body = body.slice(m[0].length)
    if (/^@charset/i.test(stmt)) {
      head.push(stmt)
      continue
    }
    // `@import "x.css"` 与 `@import url(x.css)` 两种写法；外站的整条丢掉
    const target = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/i.exec(stmt)?.[1] ?? ""
    const inside = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(target) || target.startsWith("/") ? undefined : joinInside(file, target)
    if (inside === undefined) {
      warnings.push(`${file} 的 ${stmt.slice(0, 80)} 引用了包外的样式表，已剔除`)
      continue
    }
    head.push(`@import url("${base}/${inside}");`)
  }

  body = body.replace(URL_RE, (_all, dq: string | undefined, sq: string | undefined, bare: string | undefined) =>
    rewrite(dq ?? sq ?? bare ?? "")
  )
  // 正文中段的 `@import` 本就无效，留着只会让人以为它生效了
  body = body.replace(/@import\b[^;]*;/gi, stmt => {
    warnings.push(`${file} 中段的 ${stmt.slice(0, 60)} 无效（@import 须在最前），已剔除`)
    return ""
  })

  const out = wrap ? `${head.join("\n")}\n@layer theme {\n${body}\n}\n` : `${head.join("\n")}\n${body}`
  return { css: out, warnings }
}

/** 一次资源请求的结果 */
export type ThemeAsset =
  | { readonly status: 404; readonly error: string }
  | {
      readonly status: 200
      readonly type: string
      readonly body: string | Buffer
      readonly etag: string
      /** 样式表里被剔除的东西；非样式表没有 */
      readonly warnings?: readonly string[]
    }

/**
 * 取一款主题的一个文件
 *
 * 路径先过 `isSafeEntryPath`，再确认解析后仍在包目录之内 —— 两道都要：前者挡掉 `..`，
 * 后者挡掉符号链接一类绕法之外、拼接本身的意外。扩展名不在 `MIME` 表里的一律不给：
 * 主题包里的 `package.json`、`.git/` 之类不该经这条路由流出去。
 * @param theme 主题
 * @param file 相对包目录的路径
 * @returns 文件内容或 404
 */
export async function readThemeAsset(theme: ScannedTheme, file: string): Promise<ThemeAsset> {
  const type = MIME[extname(file).toLowerCase()]
  if (type === undefined || !isSafeEntryPath(file)) return { status: 404, error: `主题 ${theme.info.id} 没有 ${file}` }
  const abs = resolve(theme.dir, file)
  const rel = relative(theme.dir, abs)
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) return { status: 404, error: `主题 ${theme.info.id} 没有 ${file}` }
  let info
  try {
    info = await stat(abs)
  } catch {
    return { status: 404, error: `主题 ${theme.info.id} 没有 ${file}` }
  }
  if (!info.isFile()) return { status: 404, error: `主题 ${theme.info.id} 没有 ${file}` }
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  if (extname(file).toLowerCase() !== ".css") return { status: 200, type, body: await readFile(abs), etag }
  const entry = theme.info.style === `${themeBaseOf(theme.info.id)}/${file}`
  const done = processThemeCss(await readFile(abs, "utf8"), file, themeBaseOf(theme.info.id), entry)
  return { status: 200, type, body: done.css, etag, warnings: done.warnings }
}
