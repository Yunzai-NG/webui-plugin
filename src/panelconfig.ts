/**
 * 模块职责：面板插件包的配置 —— 校验声明、填默认值、按声明归一化取值、读写落盘的那份 JSON
 * 依赖方向：只依赖 node 内置模块与类型包，外加本目录 `panelscan.ts` 的 `PanelPackage` 类型
 * 生命周期：纯函数部分无生命周期；`PanelConfigStore` 随 webui 的 `setup()` 建立一份
 * 注意事项：schema 只从 package.json 的 `webuiPanel.config` 读，不从 js 读：值要给浏览器与包的 node 侧
 *          两边用，若声明写在 js 里，node 就得 `import()` 一个浏览器模块才拿得到它。代价是单文件插件
 *          不能有配置项。
 *
 *          只查类型与枚举，不查 `min` / `max` / `pattern` —— 那会是第二个校验器，而语义由声明者定；
 *          且值文件可手改，包无论如何得容得下超范围的值。
 *
 *          读到坏值修好、写入坏值拒绝，两个方向刻意不同：读时修好是为了让包起得来，写时拒绝是为了让
 *          人当场知道哪一项不对。
 *
 *          值存在 webui 的数据目录而非包目录里 —— 「更新 webui」会清空包目录。落盘走临时文件加改名，
 *          避免进程中途退出留下半截 JSON。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { SchemaDescriptor, SchemaIssue } from "@yunzai-ng/types"
import type { PanelPackage } from "./panelscan.js"

/** 配置文件在数据目录之下的子目录名 */
export const CONFIG_DIR = "panelconfig"

/** `SchemaDescriptor.type` 的全部取值，与类型包里那一行一致 */
const TYPES: readonly string[] = ["object", "array", "string", "number", "boolean", "enum", "record", "unknown"]

/**
 * 是不是一个普通对象（数组与 null 均不算）
 * @param value 待判定的值
 * @returns 是否为对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 一个包的配置文件路径
 *
 * 归属那一层保留：它已写进静态目录的 URL 与包键，此处去掉会让「配置文件属于哪个包」
 * 与别处的说法不一致。归属与包名都已过 `isSafeName`，故可直接拼进路径。
 * @param dataDir webui 的数据目录
 * @param owner 归属
 * @param name 包名
 * @returns 配置文件绝对路径
 */
export function configFileOf(dataDir: string, owner: string, name: string): string {
  return join(dataDir, CONFIG_DIR, owner, `${name}.json`)
}

/**
 * 校验一份配置声明
 *
 * 顶层必须是有 `properties` 的 object：表单按顶层 `properties` 分区渲染（见 `SchemaForm.vue`），
 * 顶层给个 string 不报错，只表现为「配置按钮点开是一片空白」。
 *
 * `properties` 为空也不算声明了配置 —— 那时点开确实是空表单，与没声明无从区分。
 * @param value `webuiPanel.config` 的原值
 * @returns 通过时给出 schema，否则给出一句可写进日志与页面的原因
 */
export function checkConfigSchema(value: unknown): { ok: true; schema: SchemaDescriptor } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "webuiPanel.config 须是一个对象" }
  if (value.type !== "object") return { ok: false, reason: "webuiPanel.config 的 type 须是 object" }
  if (!isRecord(value.properties)) return { ok: false, reason: "webuiPanel.config 缺少 properties，须逐项列出配置字段" }
  if (Object.keys(value.properties).length === 0) {
    return { ok: false, reason: "webuiPanel.config 的 properties 是空的，没有可配置的字段" }
  }

  for (const [key, child] of Object.entries(value.properties)) {
    const bad = checkChild(child, key)
    if (bad !== undefined) return { ok: false, reason: bad }
  }
  return { ok: true, schema: value as unknown as SchemaDescriptor }
}

/**
 * 校验一个字段声明，递归至叶子
 *
 * 只查「表单渲染得出来」所必需的那几项：`type` 认得、object 有 properties、enum 有候选项、
 * array 与 record 的元素声明本身也合法。**不查 title / description / widget** ——
 * 缺了它们表单退回用字段名当标签，那是可用的。
 * @param value 字段声明
 * @param path 点号路径，写进原因里
 * @returns 不合格时给出一句原因，合格时 undefined
 */
function checkChild(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return `配置字段 ${path} 的声明不是一个对象`
  if (typeof value.type !== "string" || !TYPES.includes(value.type)) {
    return `配置字段 ${path} 的 type 取值 ${String(value.type)} 不认得，可选：${TYPES.join("、")}`
  }

  if (value.type === "object") {
    if (!isRecord(value.properties)) return `配置字段 ${path} 是 object，须给出 properties`
    for (const [key, child] of Object.entries(value.properties)) {
      const bad = checkChild(child, `${path}.${key}`)
      if (bad !== undefined) return bad
    }
    return undefined
  }

  if (value.type === "enum") {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      return `配置字段 ${path} 是 enum，须给出非空的 enum 候选项`
    }
    for (const item of value.enum) {
      if (!isRecord(item) || !["string", "number", "boolean"].includes(typeof item.value)) {
        return `配置字段 ${path} 的 enum 候选项须形如 { value, label }，且 value 是字符串、数字或布尔`
      }
    }
    return undefined
  }

  if (value.type === "array") return value.items === undefined ? undefined : checkChild(value.items, `${path}[]`)
  if (value.type === "record") return value.values === undefined ? undefined : checkChild(value.values, `${path}.*`)
  return undefined
}

/**
 * 拷一份值
 *
 * 用 JSON 往返而非 `structuredClone`：配置值本就来自 JSON、又要写回 JSON，而
 * `structuredClone` 会拒绝克隆代理对象（浏览器侧已踩过，见 `web/src/configedit.ts` 的 `snapshot`）。
 * @param value 原值
 * @returns 与原值无关联的一份
 */
function clone(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (JSON.parse(JSON.stringify(value)) as unknown) : value
}

/**
 * 一个字段的默认值
 *
 * object 恒给出一个对象，哪怕子字段一个默认值都没有：表单改动按点号路径就地写入
 * （`assignPath`），而它遇到中途某一层不是对象时放弃这次写入 —— 缺了这个空对象，
 * `redis.host` 这类字段改了不生效且不报错。
 * @param child 字段声明
 * @returns 默认值；没有默认值时 undefined
 */
function defaultOfChild(child: SchemaDescriptor): unknown {
  if (child.type === "object") return defaultsOf(child)
  return child.default === undefined ? undefined : clone(child.default)
}

/**
 * 一份声明的全部默认值
 *
 * 没有默认值的字段不出现在结果里，而不是给一个 `null` 占位：JSON 里的 null 与「没设过」是两个
 * 意思，而表单对两者显示相同 —— 那个 null 会在下一次保存时被当成使用者真的选了空值。
 * @param schema 顶层声明
 * @returns 默认值
 */
export function defaultsOf(schema: SchemaDescriptor): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const value = defaultOfChild(child)
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * 一个值在中文里的类别称呼，写进「收到的是……」那半句
 * @param value 值
 * @returns 类别称呼
 */
function typeOf(value: unknown): string {
  if (value === null) return "空值"
  if (Array.isArray(value)) return "一个列表"
  switch (typeof value) {
    case "string":
      return "文本"
    case "number":
      return "数字"
    case "boolean":
      return "真假值"
    case "object":
      return "一个对象"
    default:
      return "空"
  }
}

/**
 * 记一条问题
 * @param path 点号路径
 * @param message 中文说明
 * @param severity 严重程度；`warn` 不阻止保存
 * @returns 问题
 */
function issueOf(path: string, message: string, severity: "error" | "warn"): SchemaIssue {
  return { path, message, severity }
}

/**
 * 一个值与它的声明是否类型相符
 *
 * **只查类型与枚举候选**，理由见文件头。返回的 message 写成可以接在「第 3 项」「键 x 的值」
 * 后面的半句，故不以主语开头。
 * @param child 字段声明
 * @param raw 收到的值
 * @param path 点号路径
 * @returns 不符时给出一条问题，相符时 undefined
 */
function typeIssueOf(child: SchemaDescriptor, raw: unknown, path: string): SchemaIssue | undefined {
  switch (child.type) {
    case "string":
      return typeof raw === "string" ? undefined : issueOf(path, `须是文本，收到的是${typeOf(raw)}`, "error")
    case "number":
      return typeof raw === "number" && Number.isFinite(raw)
        ? undefined
        : issueOf(path, `须是数字，收到的是${typeOf(raw)}`, "error")
    case "boolean":
      return typeof raw === "boolean" ? undefined : issueOf(path, `须是真假值，收到的是${typeOf(raw)}`, "error")
    case "enum": {
      const items = child.enum ?? []
      if (items.some(item => item.value === raw)) return undefined
      const options = items.map(item => JSON.stringify(item.value)).join("、")
      return issueOf(path, `取值 ${JSON.stringify(raw)} 不在候选项里，可选：${options}`, "error")
    }
    case "array": {
      if (!Array.isArray(raw)) return issueOf(path, `须是一个列表，收到的是${typeOf(raw)}`, "error")
      if (child.items === undefined) return undefined
      for (const [i, item] of raw.entries()) {
        const bad = typeIssueOf(child.items, item, path)
        if (bad !== undefined) return issueOf(path, `第 ${i + 1} 项${bad.message}`, "error")
      }
      return undefined
    }
    case "record": {
      if (!isRecord(raw)) return issueOf(path, `须是一组键值对，收到的是${typeOf(raw)}`, "error")
      if (child.values === undefined) return undefined
      for (const [key, item] of Object.entries(raw)) {
        const bad = typeIssueOf(child.values, item, path)
        if (bad !== undefined) return issueOf(path, `键 ${key} 的值${bad.message}`, "error")
      }
      return undefined
    }
    default:
      // `unknown` 与 object（后者不走这里）：放行
      return undefined
  }
}

/**
 * 按一份 object 声明归一化一层值
 * @param schema object 声明
 * @param raw 收到的值
 * @param base 本层的点号路径前缀，顶层为空串
 * @param issues 收集问题
 * @returns 只含声明过的键的一层值
 */
function normalizeObject(
  schema: SchemaDescriptor,
  raw: unknown,
  base: string,
  issues: SchemaIssue[]
): Record<string, unknown> {
  const props = schema.properties ?? {}
  const source = isRecord(raw) ? raw : {}
  if (raw !== undefined && !isRecord(raw)) {
    issues.push(issueOf(base, `须是一个对象，收到的是${typeOf(raw)}`, "error"))
  }

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(props)) {
    const path = base === "" ? key : `${base}.${key}`
    const got = normalizeOne(child, source[key], path, issues)
    if (got !== undefined) out[key] = got
  }

  /*
   * 声明之外的键一律丢掉，但要留一句话
   *
   * 最常见的来源是「包更新后删掉了一个配置项」。记成 warn 而非 error：一条 error 会让这次保存
   * 整个被拒，于是一个早已不存在的字段挡住正当的修改，而使用者在表单上看不见它，无从删除。
   */
  for (const key of Object.keys(source)) {
    if (Object.hasOwn(props, key)) continue
    issues.push(issueOf(base === "" ? key : `${base}.${key}`, "这个字段不在配置声明里，已丢弃", "warn"))
  }
  return out
}

/**
 * 按一个字段声明归一化一个值
 *
 * 类型不符时退回默认值而非留着坏值：留着的话，包的 node 侧会在「配置里的端口是个字符串」
 * 这种情形下崩在自己的代码里，离真正的原因很远。
 * @param child 字段声明
 * @param raw 收到的值
 * @param path 点号路径
 * @param issues 收集问题
 * @returns 归一化后的值；没有值也没有默认值时 undefined
 */
function normalizeOne(child: SchemaDescriptor, raw: unknown, path: string, issues: SchemaIssue[]): unknown {
  if (child.type === "object") return normalizeObject(child, raw, path, issues)
  if (raw === undefined) return defaultOfChild(child)

  const bad = typeIssueOf(child, raw, path)
  if (bad === undefined) return clone(raw)
  issues.push(bad)
  return defaultOfChild(child)
}

/**
 * 按声明归一化一份配置值：填默认值、丢掉声明之外的键、查类型
 *
 * 一次调用同时服务两个方向（读文件时修好、写入时校验），差别只在调用方怎么对待 `issues`：读时
 * 记一条警告并用修好的那份，写时有 error 就拒掉。共用同一段代码是要紧的 —— 否则就有了
 * 「写得进去却读不出来」这种最难查的不一致。
 * @param schema 顶层声明
 * @param raw 收到的值
 * @returns 归一化后的值与其间发现的问题
 */
export function normalizeValue(
  schema: SchemaDescriptor,
  raw: unknown
): { value: Record<string, unknown>; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = []
  return { value: normalizeObject(schema, raw, "", issues), issues }
}

/**
 * 一个包在配置这件事上的键，形如 `panels/hardware`
 *
 * 与浏览器侧 `packageKeyOf` 及 `index.ts` 里那一句同一条规则：包的身份只有一个说法。
 * @param pkg 包
 * @returns 包键
 */
export function configKeyOf(pkg: PanelPackage): string {
  return `${pkg.owner}/${pkg.name}`
}

/** 存取配置所需的日志器，只用到两级 */
export interface ConfigLogger {
  /**
   * 记一条警告
   * @param msg 内容
   */
  warn(msg: string): void
  /**
   * 记一条调试信息
   * @param msg 内容
   */
  debug(msg: string): void
}

/** 一次保存的结果 */
export type PanelConfigSave =
  | {
      /** 写进去了 */
      ok: true
      /** 归一化后的值 */
      value: Record<string, unknown>
      /** 其间的提醒，均为 `warn`；`error` 会走另一路 */
      issues: SchemaIssue[]
    }
  | {
      /** 没写，值一个字节都没落盘 */
      ok: false
      /** 逐字段的原因，面板据此标注表单 */
      issues: SchemaIssue[]
    }

/**
 * 面板插件包配置的存取
 *
 * 值缓存在内存里，`get()` 是同步的：包的 node 侧在处理请求时取配置（`ctx.config()`），那条路径上
 * 不该有磁盘读，更不该是异步的 —— 一个采样函数为了读配置而变成 async，会把这份改动传染给它全部
 * 的调用点。
 *
 * 代价是手改配置文件不会被看见，要重载 webui；经面板改的走 `save()`，缓存随之更新。
 */
export class PanelConfigStore {
  /** webui 的数据目录 */
  readonly #dataDir: string

  /** 日志器 */
  readonly #logger: ConfigLogger

  /** 包键 → 当前值 */
  readonly #values = new Map<string, Record<string, unknown>>()

  /**
   * @param dataDir webui 的数据目录
   * @param logger 日志器
   */
  constructor(dataDir: string, logger: ConfigLogger) {
    this.#dataDir = dataDir
    this.#logger = logger
  }

  /**
   * 取一个包当前的配置值
   *
   * 尚未 `ensure()` 过的包给空对象而不抛错：一个刚放进目录、还没被清单端点碰过的包
   * 正是这种情形，而那时它的 node 侧也还没跑起来。
   * @param key 包键
   * @returns 当前值
   */
  get(key: string): Record<string, unknown> {
    return this.#values.get(key) ?? {}
  }

  /**
   * 确保一个包的配置已读进内存，并给出它
   *
   * 读到坏值时修好并记一条警告，不报废整份配置：手改坏了一个字段不该让这个包连默认值都拿不到。
   * 文件不存在是常态（还没配置过），此时给默认值且不出声。
   * @param pkg 包
   * @returns 当前值；这个包没声明配置时为空对象
   */
  async ensure(pkg: PanelPackage): Promise<Record<string, unknown>> {
    const key = configKeyOf(pkg)
    const cached = this.#values.get(key)
    if (cached !== undefined) return cached
    if (pkg.config === undefined) return {}

    const file = configFileOf(this.#dataDir, pkg.owner, pkg.name)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(file, "utf8")) as unknown
    } catch (err) {
      // 文件不存在是常态；解析失败则要出声，那意味着这份文件已经不是一份 JSON
      if ((err as { code?: string }).code !== "ENOENT") {
        this.#logger.warn(`面板插件包 ${key} 的配置文件读不动（${file}），本次用默认值：${String(err)}`)
      }
      raw = undefined
    }

    const { value, issues } = normalizeValue(pkg.config, raw)
    for (const bad of issues) {
      this.#logger.warn(`面板插件包 ${key} 的配置项 ${bad.path === "" ? "（根）" : bad.path} ${bad.message}`)
    }
    this.#values.set(key, value)
    return value
  }

  /**
   * 保存一份新值
   *
   * 有 `error` 级问题时**一个字节都不写**：半份写进去的配置比整份拒掉难查得多。
   * @param pkg 包
   * @param raw 收到的整份值
   * @returns 写入结果
   */
  async save(pkg: PanelPackage, raw: unknown): Promise<PanelConfigSave> {
    const key = configKeyOf(pkg)
    if (pkg.config === undefined) {
      return { ok: false, issues: [issueOf("", `面板插件包 ${key} 没有声明配置项`, "error")] }
    }

    const { value, issues } = normalizeValue(pkg.config, raw)
    if (issues.some(item => item.severity === "error")) return { ok: false, issues }

    await this.#write(configFileOf(this.#dataDir, pkg.owner, pkg.name), value)
    this.#values.set(key, value)
    this.#logger.debug(`面板插件包 ${key} 的配置已保存`)
    return { ok: true, value, issues }
  }

  /**
   * 恢复默认值：删掉那份文件
   *
   * 删文件而不是写一份等于默认值的文件：两者此刻等价，但包更新后改了某项默认值时，前者跟着变、
   * 后者钉在旧默认值上，而使用者以为自己「从未配置过这一项」。
   * @param pkg 包
   * @returns 默认值
   */
  async reset(pkg: PanelPackage): Promise<Record<string, unknown>> {
    const key = configKeyOf(pkg)
    await rm(configFileOf(this.#dataDir, pkg.owner, pkg.name), { force: true })
    const value = pkg.config === undefined ? {} : defaultsOf(pkg.config)
    this.#values.set(key, value)
    this.#logger.debug(`面板插件包 ${key} 的配置已恢复默认值`)
    return value
  }

  /**
   * 落盘：先写临时名再 rename，理由见文件头
   * @param file 目标文件
   * @param value 值
   */
  async #write(file: string, value: Record<string, unknown>): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true })
    const temp = `${file}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(temp, file)
  }
}
