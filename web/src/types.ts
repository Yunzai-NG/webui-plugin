/**
 * 模块职责：面板 API 的响应形状
 * 依赖方向：仅引用 `@yunzai-ng/types`
 * 生命周期：纯类型
 * 注意事项：约半数形状在此重新声明是刻意的：`LoginSnapshot`、`RendererInfo`、`ConfigSummary`、
 *          `LogRecord` 定义于 `@yunzai-ng/core`，而分层门禁禁止前端依赖内核，故按 HTTP 契约
 *          另声明一份 —— 前端消费的本就是 JSON。
 *
 *          代价是内核改响应形状时此处不会立即报错。故只声明**前端确实读取的字段**，
 *          未读取的不声明，其变更与前端无关。
 */
import type {
  AccountState,
  CommandInfo,
  LogLevel,
  LoginModeDescriptor,
  LoginPrompt,
  LoginStep,
  MiddlewareInfo,
  PlatformInfo,
  PluginState,
  ResourceUsage,
  RuntimePaths,
  SchemaDescriptor,
  ServerInfo,
  TaskInfo
} from "@yunzai-ng/types"

export type {
  AccountRecord,
  AccountState,
  CommandInfo,
  LogLevel,
  LoginPrompt,
  LoginStep,
  MiddlewareInfo,
  PluginState,
  SchemaDescriptor,
  SchemaEnumItem,
  SchemaIssue,
  SchemaWidget,
  TaskInfo
} from "@yunzai-ng/types"

/** `GET /api/overview` */
export interface Overview {
  /** 内核版本 */
  version: string
  /** 运行状态 */
  status: string
  /** 启动时刻（毫秒时间戳） */
  startedAt: number
  /** 已运行毫秒 */
  uptime: number
  /** 运行环境 */
  platform: PlatformInfo
  /** 目录布局 */
  paths: RuntimePaths
  /** 资源占用 */
  usage: ResourceUsage
  /** 服务器状态 */
  server: ServerInfo & {
    /** 面板是否只读 */
    readonly: boolean
    /** 当前 WebSocket 连接数 */
    connections: number
  }
  /** 各子系统计数 */
  counts: {
    /** 已发现插件数 */
    plugins: number
    /** 其中加载失败的 */
    pluginsFailed: number
    /** 命令数 */
    commands: number
    /** 定时任务数 */
    tasks: number
    /** 适配器数 */
    adapters: number
    /** 账号数 */
    accounts: number
    /** 在线账号数 */
    online: number
    /** 渲染器数 */
    renderers: number
    /** 进行中的登录会话数 */
    logins: number
  }
  /** 消息管线 */
  pipeline: {
    /** 累计处理事件数 */
    handled: number
    /** 当前排队数 */
    queued: number
  }
}

/** 一个分区的占用 */
export interface DiskInfo {
  /** 挂载点；Windows 上形如 `C:\` */
  mount: string
  /** 总容量（字节） */
  total: number
  /** 可用容量（字节） */
  free: number
  /** 已用容量（字节） */
  used: number
}

/** 一块显卡 */
export interface GpuInfo {
  /** 型号名 */
  name: string
  /** 占用率（0-1）；驱动未给出时不出现 */
  load?: number
  /** 显存已用（字节） */
  memoryUsed?: number
  /** 显存总量（字节） */
  memoryTotal?: number
}

/**
 * `GET /api/system`
 *
 * **CPU 与内存不在这里**，在 `Overview` 的 `usage` 与 `platform` 里。同一事实两处供给，
 * 采样时刻不同，页面上就会出现「CPU 卡片与 CPU 环不是一个数」。
 */
export interface SystemInfo {
  /** 各分区占用；一个都探不到时为空数组 */
  disks: DiskInfo[]
  /**
   * 各显卡
   *
   * **测不到时本字段不出现**，与「有 0 块显卡」相区分：后者仍画出一个空组件，前者整个隐去。
   * 故此处是 `?` 而非空数组兜底。
   */
  gpus?: GpuInfo[]
}

/** `GET /api/config` 的元素 */
export interface ConfigSummary {
  /** 配置名，同时用作 URL 中的 `:name` */
  name: string
  /** 文件绝对路径 */
  file: string
  /** 显示标题 */
  title: string
  /** 表单描述 */
  schema: SchemaDescriptor
}

/** `GET /api/config/:name` */
export interface ConfigDetail extends ConfigSummary {
  /** 当前值 */
  value: Record<string, unknown>
}

/** `GET /api/adapters` 的元素 */
export interface AdapterSummary {
  /** 适配器 id */
  id: string
  /** 展示名 */
  name: string
  /** 说明 */
  description?: string
  /** 平台标识 */
  platform: string
  /** 账号配置的表单描述 —— 添加账号的表单完全由其渲染 */
  accountSchema: SchemaDescriptor
  /** 支持的交互式登录方式；为空表示仅能手工填写配置 */
  loginModes?: readonly LoginModeDescriptor[]
}

/** `GET /api/renderers` 的元素 */
export interface RendererInfo {
  /** 渲染器 id */
  id: string
  /** 展示名 */
  name: string
  /** 提供方插件名 */
  owner: string
  /** 是否为当前首选 */
  preferred: boolean
  /** 最近判定的可用性 */
  available?: boolean
  /** 最近失败原因 */
  lastError?: string
  /** 累计成功次数 */
  succeeded: number
  /** 累计失败次数 */
  failed: number
}

/** 正在等待用户回答的提问 */
export interface PendingPrompt {
  /** 提问序号，回答时必须携带 */
  seq: number
  /** 提问内容 */
  prompt: LoginPrompt
  /** 超时时刻（毫秒时间戳） */
  deadline: number
}

/** `GET /api/logins` 的元素 */
export interface LoginSnapshot {
  /** 会话 id */
  id: string
  /** 适配器 id */
  adapterId: string
  /** 登录方式 id */
  mode: string
  /**
   * 当前状态
   *
   * 取值必须与内核 `LoginStatus` 一致。等待用户输入时状态仍为 `running`，
   * 是否显示输入框取决于 `pending` 而非本字段。
   */
  status: "running" | "done" | "failed" | "cancelled"
  /** 已推送的步骤 */
  steps: readonly LoginStep[]
  /** 正在等待的提问 */
  pending?: PendingPrompt
  /** 失败原因 */
  error?: string
  /** 成功时创建的账号记录 id */
  accountId?: string
  /** 开始时刻 */
  startedAt: number
  /** 最后变化时刻 */
  updatedAt: number
}

/** 一条日志 */
export interface LogRecord {
  /** 级别 */
  level: LogLevel
  /** 毫秒时间戳 */
  time: number
  /** 主消息 */
  msg: string
  /** 作用域 */
  scope?: string
  /** 错误堆栈 */
  stack?: string
  /** 其余业务字段 */
  fields?: Record<string, unknown>
}

/** `GET /api/logs` */
export interface LogPage {
  /** 日志文件路径；仅输出至控制台时为空 */
  file?: string
  /** 当前总级别 */
  level: LogLevel
  /** 记录，时间升序 */
  records: LogRecord[]
}

/** `GET /api/server` */
export interface ServerDetail extends ServerInfo {
  /** 面板是否只读 */
  readonly: boolean
  /** 当前连接数 */
  connections: number
  /** 已注册的 HTTP 路由 */
  routes: Array<{
    /** 方法 */
    method: string
    /** 完整路径模式 */
    pattern: string
    /** 注册者前缀 */
    scope: string
    /** 是否需要鉴权 */
    auth: boolean
  }>
  /** 已注册的 WebSocket 端点 */
  websockets: Array<{
    /** 完整路径模式 */
    pattern: string
    /** 注册者前缀 */
    scope: string
  }>
  /** 已挂载的静态目录 */
  static: Array<{
    /** URL 前缀 */
    pattern: string
    /** 本地目录 */
    dir: string
    /** 是否为 SPA 回退 */
    spa: boolean
  }>
}

/** 账号列表元素即内核的账号状态，不另行包装 */
export type AccountItem = AccountState

/** 插件列表元素 */
export type PluginItem = PluginState

/** 命令列表元素 */
export type CommandItem = CommandInfo

/** 定时任务列表元素 */
export type TaskItem = TaskInfo

/** 中间件列表元素（`GET /api/middlewares`），顺序即实际的执行顺序 */
export type MiddlewareItem = MiddlewareInfo

/** 插件市场索引中的一个条目（`GET /api/market` 的 `plugins` 元素） */
export interface MarketItem {
  /** 插件名，同时是安装目录名与配置文件名 */
  name: string
  /** 展示标题 */
  title: string
  /** 一句话说明 */
  description: string
  /** 作者 */
  author?: string
  /** 索引声明的版本 */
  version?: string
  /** 项目主页 */
  homepage?: string
  /** 分类标签 */
  tags: string[]
  /** 是否为官方维护 */
  official: boolean
  /** 要求的最低内核版本 */
  minCore?: string
  /** 条目来自哪个索引地址 */
  source: string
  /** 插件目录下是否已存在同名目录 */
  installed: boolean
}

/** 一个索引地址的获取结果 */
export interface MarketSource {
  /** 索引地址 */
  url: string
  /** 是否取到并解析成功 */
  ok: boolean
  /** 失败原因 */
  error?: string
  /** 该索引贡献的条目数 */
  count: number
}

/** `GET /api/market` */
export interface MarketSnapshot {
  /** 获取时刻（毫秒时间戳） */
  fetchedAt: number
  /** 是否来自缓存而非本次网络请求 */
  cached: boolean
  /** 逐个索引的获取结果 */
  sources: MarketSource[]
  /** 合并去重后的条目，按名称排序 */
  plugins: MarketItem[]
}

/** `POST /api/market/install` 与 `POST /api/market/:name/update` */
export interface MarketInstallResult {
  /** 插件名 */
  name: string
  /** 安装目录 */
  dir: string
  /**
   * 取源方式
   *
   * `pull` 是更新独有的一种：目录已是 git 仓库，就地 `fetch` + `reset --hard`。与 `git` 分开
   * 是因为可见后果不同 —— `pull` 保住了那份 `node_modules`，`git` 是全新目录、依赖得重装。
   */
  via: "git" | "tarball" | "pull"
  /** 实际安装到的版本 */
  version: string
  /** 就地拉取前的版本号，仅 `via` 为 `pull` 时存在 */
  fromVersion?: string
  /** 就地拉取时是否确实有新提交；假即已是最新。仅 `via` 为 `pull` 时存在 */
  changed?: boolean
  /** 是否声明了运行时依赖且尚未安装 */
  needsDependencies: boolean
  /** 覆盖安装前是否卸载了旧版本 */
  unloaded: boolean
  /** 本次加载成功的插件名 */
  loaded: string[]
}

/* ─────────────────────── 面板插件商店 ─────────────────────── */

/**
 * 商店里的一个面板插件
 *
 * 与 `MarketItem` 是两回事，故不复用：版本门是 `minWebui` 而非 `minCore`（面板插件用的是
 * webui 给的注入口），另有组件数、node 侧与依赖三项**预告**。合成一个类型就要给每个字段
 * 加一句「这个只对某一类有效」。
 */
export interface PanelStoreItem {
  /** 包名，同时是安装目录名 */
  name: string
  /** 展示标题 */
  title: string
  /** 一句话说明 */
  description: string
  /** 作者 */
  author?: string
  /** 索引声明的版本 */
  version?: string
  /** 项目主页 */
  homepage?: string
  /** 分类标签 */
  tags: string[]
  /** 是否为官方维护 */
  official: boolean
  /** 要求的最低 **webui** 版本 */
  minWebui?: string
  /**
   * 组件数 —— 索引作者填的**预告**，不是事实
   *
   * 真实数目要浏览器 `import()` 过才知道，故卡片上写「约 N 枚」。装完以插件页那张卡片为准。
   */
  widgets?: number
  /** 是否带 node 侧入口 —— 同为预告 */
  server?: boolean
  /** 是否声明了依赖 —— 同为预告 */
  deps?: boolean
  /** 该条目来自哪个索引地址 */
  source: string
  /** 落点下是否已存在同名目录 */
  installed: boolean
  /** 已装的版本，读自磁盘上的 package.json */
  installedVersion?: string
  /** 索引里的版本是否高于已装的版本；未安装时恒为假 */
  updatable: boolean
}

/** 一个索引地址的获取结果 */
export interface PanelStoreSource {
  /** 索引地址 */
  url: string
  /** 是否取到并解析成功 */
  ok: boolean
  /** 失败原因 */
  error?: string
  /** 该索引贡献的条目数 */
  count: number
}

/** `GET /plugin/webui/panelstore` */
export interface PanelStoreSnapshot {
  /** 获取时刻（毫秒时间戳） */
  fetchedAt: number
  /** 是否来自缓存而非本次网络请求 */
  cached: boolean
  /** 逐个索引的获取结果 */
  sources: PanelStoreSource[]
  /** 合并去重后的条目，按名称排序 */
  panels: PanelStoreItem[]
  /**
   * 面板是否处于只读模式
   *
   * 前端据此隐去写按钮。**这不是门** —— 门在 node 侧，四条写路由各自判一次；此处只为
   * 不摆一个点了必报错的按钮。
   */
  readonly: boolean
}

/** `POST /plugin/webui/panelstore/install` 与 `.../:name/update` */
export interface PanelStoreResult {
  /** 包名 */
  name: string
  /** 安装目录 */
  dir: string
  /** 取源方式；`pull` 为就地拉取，保住了 `node_modules` */
  via: "git" | "tarball" | "pull"
  /** 实际装到的版本 */
  version: string
  /** 是否声明了运行时依赖且尚未安装 */
  needsDependencies: boolean
  /**
   * 是否带 node 侧入口
   *
   * **决定「装完该做什么」**：没有它刷新页面即生效，有它须重载 webui。见 `panelstore.ts`
   * 的 `nextText`。
   */
  hasServer: boolean
  /**
   * 此后的更新走哪条路
   *
   * `pull` 表示目录带 `.git`、就地拉取并保住 `node_modules`；`reinstall` 表示每次整目录重下、
   * 依赖跟着重装。装完即告知，因为它决定此后每次更新要等多久。
   */
  updatable: "pull" | "reinstall"
  /** 就地拉取前的版本号，仅 `via` 为 `pull` 时存在 */
  fromVersion?: string
  /** 就地拉取时是否确实有新提交；假即已是最新 */
  changed?: boolean
  /** 本次是否真的跑过包管理器 */
  installedDeps?: boolean
  /** 跑包管理器时用的是哪个 */
  packageManager?: string
  /** 跑包管理器失败的原因 */
  dependencyError?: string
}
