/**
 * 模块职责：面板插件的形状校验 —— 清单是否可用、一个插件模块是否长成约定的样子
 * 依赖方向：只依赖 panelapi 的**类型**（`import type` 在运行期被完全擦除）；不依赖 vue，
 *          不依赖 api，故可在 node 环境下跑用例
 * 生命周期：纯函数
 * 注意事项：与 `panelload.ts` 分开是为了能测：用例跑在 node 环境（无 jsdom），而
 *          `panelload.ts` → `panelapi.ts` → `api.ts` 模块级就读 `localStorage`，在 node 下
 *          直接抛错。校验是这一路里唯一「算错了不报错、只表现为组件莫名不出现」的部分。
 *
 *          校验不通过时给出 `reason` 而非抛错：调用方拿这句话去画占位格，故每条都要自带
 *          「哪里不对」且写成能示于卡片内的短句。
 *
 *          `page` 要对着已有页面校验 —— 写错不报任何错，只是那个组件在每一页都不出现。
 *          可选页面由调用方传入而非从 `router.ts` 取：那个模块在模块级就 `location.hash`
 *          与 `addEventListener`，import 进来本文件就不能测了。
 */
import type { PanelTab, PanelWidget } from "./panelapi.js"
import type { SchemaDescriptor } from "./types.js"

/**
 * 清单里的一项，与 node 侧 `src/panelscan.ts` 的 `PanelEntry` 同形
 *
 * 刻意各写一份而不共用：那边在插件的 `src/` 下（NodeNext），这边在 `web/src/` 下
 * （bundler 解析、另一份 tsconfig），跨过去 import 要把两套模块解析规则并到一处。
 * 两份之间的一致由 `temp/check-panelplugin.mjs` 走真实的一整趟来保证。
 */
export interface PanelEntry {
  /** 归属，恒为 `panels` —— 面板插件只有一处落点 */
  owner: string
  /** 文件名；多文件时为 `<名>/index.js` */
  file: string
  /** 可直接 `import()` 的 URL */
  url: string
  /** 单文件还是多文件；缺省当单文件，故旧清单仍可用 */
  kind?: "single" | "multi"
  /** node 侧从 package.json 读到的自报信息；单文件那一路没有，须从模块导出取 */
  meta?: PanelMeta
  /** 该包 node 侧路由的基地址；无 node 侧入口时没有此项。由 node 侧算出，不在此处拼 */
  api?: string
  /**
   * 这个包自带样式表的地址；未声明时没有此项
   *
   * 取到的文本要先限定到本包再注入（见 `panelstyle.ts`）—— 原样注入的话，一个包写的
   * `.card { }` 改的是整个面板的卡片。
   */
  style?: string
  /** 样式表声明有问题的原因；没声明或没问题时没有此项。同 `configError`，写了没生效总得有话说 */
  styleError?: string
  /**
   * 这个包的配置：声明与当前值，两者一并由 node 侧给出
   *
   * **schema 不在浏览器侧算，值也不在浏览器侧填默认。** node 侧从包的 package.json 里读出
   * 声明、按它填好默认值再送来（见 `src/panelconfig.ts` 文件头）—— 两侧各填一遍默认值，
   * 走形时的表现是「面板上显示 6379，而 node 侧连的是 undefined」。
   */
  config?: {
    /** 表单描述 */
    schema: SchemaDescriptor
    /** 当前值，已填过默认值 */
    value: Record<string, unknown>
  }
  /** 配置声明写坏了的原因；写对了或没声明时没有此项 */
  configError?: string
}

/**
 * 一个面板插件的自报信息，与 node 侧 `src/panelscan.ts` 的 `PanelMeta` 同形
 *
 * 两份各写一份的理由同 `PanelEntry`。
 */
export interface PanelMeta {
  /** 版本号 */
  version: string
  /** 一句话说明 */
  description: string
  /** 仓库地址 */
  repository: string
  /** 作者名 */
  author: string
}

/** 一次形状校验的结果 */
export type PanelCheck =
  | {
      /** 通过 */
      ok: true
      /** 校验过的插件定义 */
      widget: PanelWidget
    }
  | {
      /** 未通过 */
      ok: false
      /** 面向使用者的一句原因，将显示在占位格里 */
      reason: string
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
 * 是不是非空字符串
 * @param value 待判定的值
 * @returns 是否为非空字符串
 */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * 是不是可作栅格尺寸的正整数
 *
 * 取整数而非任意正数：`grid.ts` 全程按整数列 / 行计算，给个 2.5 不会报错，
 * 只会让这一格与相邻的格子错开半格。
 * @param value 待判定的值
 * @returns 是否为 ≥1 的整数
 */
function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
}

/**
 * 一项在日志与占位格里的称呼
 * @param entry 清单项
 * @returns 形如 `panels/hardware.js` 的文本
 */
export function entryLabel(entry: PanelEntry): string {
  return `${entry.owner}/${entry.file}`
}

/**
 * 一项所属包的键
 *
 * 与 `entryLabel` 并列：一个给人看，一个给程序用。靠拆标签文本反推包名就是拿显示用的
 * 字符串当数据来源 —— 改一次格式归并即失效，且表现为「一个包忽然摊成十张卡片」。
 *
 * 多文件取目录名（`panels/hardware/index.js` → `panels/hardware`），单文件取文件名本身
 * （单文件的 `file` 里没有斜杠，取首段即是它自己）。node 侧 `src/index.ts` 判「这个包的
 * node 侧跑起来了吗」用的是同一条规则。单文件也算一个包，否则插件页要分两种列法。
 * @param entry 清单项
 * @returns 形如 `panels/hardware` 或 `panels/clock.js` 的包键
 */
export function packageKeyOf(entry: PanelEntry): string {
  return `${entry.owner}/${entry.file.split("/")[0] ?? entry.file}`
}

/**
 * 占位格的组件标识
 *
 * 带上文件名：一个目录里可能有多个坏文件，只取归属会让它们撞成同一个 id，而注册表拒绝
 * 重复 —— 于是后一个坏文件连占位格都没有，表现为「明明放了却什么都没出现」。
 * @param entry 清单项
 * @returns 形如 `panelfail.panels.hardware.js` 的标识
 */
export function placeholderId(entry: PanelEntry): string {
  return `panelfail.${entry.owner}.${entry.file}`
}

/**
 * 校验清单响应
 *
 * 清单由自己那半 node 侧给出，本不该走形；但它经 HTTP 而来，中间可能是一台反向代理
 * 返回的错误页。取不出 `items` 时给空数组而不抛错：一份取不到的清单意味着
 * 「没有面板插件」，那与「面板坏了」是两件事。
 * @param value 响应体
 * @returns 其中形状齐备的那些项
 */
export function parseManifest(value: unknown): PanelEntry[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.filter(
    (item): item is PanelEntry =>
      isRecord(item) && isText(item.owner) && isText(item.file) && isText(item.url)
  )
}

/**
 * 从一个仓库地址里推出归属名，与 node 侧 `src/panelscan.ts` 的同名函数同规则
 *
 * `git+https://github.com/Yunzai-NG/hardware-plugin.git` → `Yunzai-NG`。取路径上倒数
 * 第二段：GitHub、Gitee、GitLab 的 `<主机>/<归属>/<仓库>` 形状一致，SSH 写法
 * （`git@github.com:Yunzai-NG/x.git`）冒号后面也是同样两段。
 * @param repo 仓库地址
 * @returns 取得到时给出归属名，否则 undefined
 */
export function ownerFromRepo(repo: string): string | undefined {
  const parts = repo
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(part => part !== "")
  return parts.length >= 2 ? parts[parts.length - 2] : undefined
}

/**
 * 从一个值里取自报信息
 *
 * 版本、说明、仓库三项缺一不可，`author` 缺则从仓库地址推 —— 与 node 侧读 package.json
 * 的规则逐字一致，两侧门槛不同没有道理可讲，只会被当成写错了。
 *
 * 缺则给 undefined 而非补空串：调用方据此画占位格，而 `author: ""` 在插件页上与填好了
 * 没有区别。
 * @param value 待取的值（模块的 `meta` 导出，或 node 侧给的 `entry.meta`）
 * @returns 三项齐备时给出，否则 undefined
 */
export function pickMeta(value: unknown): PanelMeta | undefined {
  if (!isRecord(value)) return undefined
  const { version, description, repository, author } = value
  if (!isText(version) || !isText(description) || !isText(repository)) return undefined

  const repo = repository.trim()
  const who = isText(author) ? author.trim() : ownerFromRepo(repo)
  if (who === undefined) return undefined

  return {
    version: version.trim(),
    description: description.trim(),
    repository: repo,
    author: who
  }
}

/**
 * 定出一项的自报信息
 *
 * **有 package.json 的不看模块导出**，免得同一份信息两处记、有一天不一致。空着时才看
 * 模块导出：一个孤零零的 js 没有别处可记，故单文件一律须 `export const meta`。
 *
 * **按 `entry.meta` 在不在分派，而不按 `kind`**：「多文件却读不到 meta」是真实情形
 * （package.json 缺字段），那时该报的是「去补 package.json」而非「去 js 里加 meta 导出」。
 *
 * reason 直接示于占位格，故须写明缺哪几项与该写在哪 —— 只说「加载失败」使用者只能来问。
 * @param mod `import()` 得到的模块对象
 * @param entry 清单项
 * @returns 齐备时带上 meta，否则带上一句原因
 */
export function resolvePanelMeta(
  mod: unknown,
  entry: PanelEntry
): { ok: true; meta: PanelMeta } | { ok: false; reason: string } {
  const fromNode = pickMeta(entry.meta)
  if (fromNode !== undefined) return { ok: true, meta: fromNode }

  // 多文件却没读到：那是它的 package.json 缺字段，改 js 无用，故指向 package.json
  if (entry.kind === "multi") {
    return {
      ok: false,
      reason: `${entry.file} 所在目录的 package.json 缺少 version、description、repository、author 之一，四项缺一不可`
    }
  }

  const meta = pickMeta(isRecord(mod) ? mod.meta : undefined)
  if (meta === undefined) {
    return {
      ok: false,
      reason: "缺少 meta 导出。单文件面板插件须写 export const meta = { version, description, repository, author }"
    }
  }
  return { ok: true, meta }
}

/**
 * 校验一个组件定义的形状
 * @param def 定义对象
 * @param pages 可选的页面标识，取 `ROUTES` 中的 id
 * @param where 位置说明，写进 reason 里；多个组件时形如「第 2 个组件」
 * @returns 通过时带上定义，否则带上一句原因
 */
function checkOneWidget(def: unknown, pages: readonly string[], where = ""): PanelCheck {
  const at = where === "" ? "" : `${where}：`
  if (!isRecord(def)) return { ok: false, reason: `${at}没有默认导出，须 export default { ... }` }

  if (!isText(def.id)) return { ok: false, reason: `${at}缺少 id，它是这个组件的唯一标识` }
  if (!isText(def.title)) return { ok: false, reason: `${at}缺少 title，编辑态要用它称呼这个组件` }

  if (!isText(def.page)) return { ok: false, reason: `${at}缺少 page，它决定这个组件挂在哪一页` }
  if (!pages.includes(def.page)) {
    return { ok: false, reason: `${at}page 取值 ${def.page} 不是已有的页面，可选：${pages.join("、")}` }
  }

  const layout = def.defaultLayout
  if (!isRecord(layout)) return { ok: false, reason: `${at}缺少 defaultLayout，须给出 w 与 h` }
  if (!isSize(layout.w)) return { ok: false, reason: `${at}defaultLayout.w 须是不小于 1 的整数` }
  if (!isSize(layout.h)) return { ok: false, reason: `${at}defaultLayout.h 须是不小于 1 的整数` }
  if (layout.minW !== undefined && !isSize(layout.minW)) {
    return { ok: false, reason: `${at}defaultLayout.minW 须是不小于 1 的整数` }
  }
  if (layout.minH !== undefined && !isSize(layout.minH)) {
    return { ok: false, reason: `${at}defaultLayout.minH 须是不小于 1 的整数` }
  }

  if (layout.resizable !== undefined && typeof layout.resizable !== "boolean") {
    return { ok: false, reason: `${at}defaultLayout.resizable 须是 true 或 false` }
  }
  /*
   * 声明可调就得给下限，缺一项即不通过
   *
   * 少了下限时 `specsOf` 替它取 1，这一格便能被拖成 1×1 —— 挤成一团且不报任何错，
   * 使用者只会觉得「这个组件缩小之后就坏了」。故在装载时拦下，给占位格。
   *
   * 反过来（给了下限却没声明 resizable）不算错：`clampSlot` 拿下限挡落盘里的坏值。
   */
  if (layout.resizable === true && (layout.minW === undefined || layout.minH === undefined)) {
    return {
      ok: false,
      reason: `${at}defaultLayout 声明了 resizable，但缺少 minW 或 minH。可调大小的组件须给出它缩到多小仍能看`
    }
  }

  if (def.defaultHidden !== undefined && typeof def.defaultHidden !== "boolean") {
    return { ok: false, reason: `${at}defaultHidden 须是 true 或 false` }
  }

  if (typeof def.setup !== "function") {
    return { ok: false, reason: `${at}setup 不是函数，它须返回一个渲染函数` }
  }

  return { ok: true, widget: def as unknown as PanelWidget }
}

/**
 * 校验一个面板插件模块的形状
 * @param mod `import()` 得到的模块对象
 * @param pages 可选的页面标识，取 `ROUTES` 中的 id
 * @returns 通过时带上定义，否则带上一句原因
 */
export function checkPanelWidget(mod: unknown, pages: readonly string[]): PanelCheck {
  if (!isRecord(mod)) return { ok: false, reason: "模块不是对象" }
  return checkOneWidget(mod.default, pages)
}

/**
 * 校验一个面板插件模块，允许它一次给出多个组件
 *
 * **一个模块可以 `export default [a, b, c]`**：hardware 这类插件一口气给十来枚组件，
 * 而多文件包只认一个 `index.js`，一个文件一个组件就得让使用者装十个包。
 *
 * **一个都不合格才算整体失败；部分合格的照收** —— 一枚写错字段不连坐其余九枚。
 * 被丢掉的那些各留一句原因，由调用方决定怎么说。
 * @param mod `import()` 得到的模块对象
 * @param pages 可选的页面标识，取 `ROUTES` 中的 id
 * @returns 至少一枚合格时给出合格的那些与被丢掉的原因，否则给出一句原因
 */
export function checkPanelWidgets(
  mod: unknown,
  pages: readonly string[]
): { ok: true; widgets: PanelWidget[]; skipped: string[] } | { ok: false; reason: string } {
  if (!isRecord(mod)) return { ok: false, reason: "模块不是对象" }

  const def = mod.default
  if (!Array.isArray(def)) {
    const one = checkOneWidget(def, pages)
    return one.ok ? { ok: true, widgets: [one.widget], skipped: [] } : one
  }

  if (def.length === 0) return { ok: false, reason: "默认导出是一个空数组，须至少给出一个组件" }

  const widgets: PanelWidget[] = []
  const skipped: string[] = []
  for (const [i, item] of def.entries()) {
    const one = checkOneWidget(item, pages, `第 ${i + 1} 个组件`)
    if (one.ok) widgets.push(one.widget)
    else skipped.push(one.reason)
  }

  if (widgets.length === 0) return { ok: false, reason: skipped.join("；") }
  return { ok: true, widgets, skipped }
}

/**
 * 校验一个页签定义的形状
 * @param def 定义对象
 * @param where 位置说明，写进 reason 里；形如「第 2 个页签」
 * @returns 通过时带上定义，否则带上一句原因
 */
function checkOneTab(def: unknown, where = ""): { ok: true; tab: PanelTab } | { ok: false; reason: string } {
  const at = where === "" ? "" : `${where}：`
  if (!isRecord(def)) return { ok: false, reason: `${at}不是对象，页签须是 { id, title, setup }` }
  if (!isText(def.id)) return { ok: false, reason: `${at}缺少 id，它是这个页签的唯一标识` }
  if (!isText(def.title)) return { ok: false, reason: `${at}缺少 title，插件页要用它称呼这个页签` }
  if (typeof def.setup !== "function") {
    return { ok: false, reason: `${at}setup 不是函数，它须返回一个渲染函数` }
  }
  return { ok: true, tab: def as unknown as PanelTab }
}

/**
 * 校验一个模块的 `tabs` 导出
 *
 * **没有 `tabs` 导出不是错**：绝大多数包只出组件，当作不通过会让每个既有插件都多出一句
 * 错话。故三种结果是「没有」「有且合格的那些」「有但一个都不合格」，而不是通过与否。
 *
 * **部分合格的照收，与组件同一取舍**（见 `checkPanelWidgets`）。被丢掉的原因只进控制台与
 * 包详情 —— 页签没有占位格可去（占位格是栅格里的一格，页签占的是整块内容区）。
 * @param mod `import()` 得到的模块对象
 * @returns 合格的页签与被丢掉的原因
 */
export function checkPanelTabs(mod: unknown): { tabs: PanelTab[]; skipped: string[] } {
  if (!isRecord(mod) || mod.tabs === undefined) return { tabs: [], skipped: [] }

  const raw = mod.tabs
  if (!Array.isArray(raw)) {
    const one = checkOneTab(raw)
    return one.ok ? { tabs: [one.tab], skipped: [] } : { tabs: [], skipped: [one.reason] }
  }

  const tabs: PanelTab[] = []
  const skipped: string[] = []
  for (const [i, item] of raw.entries()) {
    const one = checkOneTab(item, `第 ${i + 1} 个页签`)
    if (one.ok) tabs.push(one.tab)
    else skipped.push(one.reason)
  }
  return { tabs, skipped }
}

/**
 * 配置的 schema 是不是写在了读得到的地方
 *
 * **本函数的全部用处是消灭一种「写了却没反应」。** schema 只从包 package.json 的
 * `webuiPanel.config` 读（理由见 `src/panelconfig.ts` 文件头），于是三种写法什么都不会发生：
 * 单文件里写 `export const config`（它没有 package.json）、包把 schema 写进 `index.js`、
 * 两处都写（js 那份被忽略）。前两种的表现都只是「插件页上没有配置按钮」。
 *
 * **声明写坏了不在此处说**：那一种由 node 侧给出 `entry.configError`（它读得到具体错在哪）。
 * @param mod `import()` 得到的模块对象
 * @param entry 清单项
 * @returns 有问题时给出一句可示于包详情的原因，否则 undefined
 */
export function checkConfigPlace(mod: unknown, entry: PanelEntry): string | undefined {
  const declared = isRecord(mod) && mod.config !== undefined

  if (entry.config !== undefined) {
    return declared
      ? "配置已从 package.json 的 webuiPanel.config 读到，模块里的 config 导出不会被读取，请删掉它以免两处不一致"
      : undefined
  }
  if (!declared || entry.configError !== undefined) return undefined

  return entry.kind === "multi"
    ? "配置的 schema 须写在包 package.json 的 webuiPanel.config 里；index.js 里的 config 导出不会被读取"
    : "单文件面板插件不支持配置项：schema 须由 node 侧读得到，而单个 .js 没有 package.json。需要配置请改成一个包（一个目录 + index.js + package.json）"
}

/**
 * 样式表是不是声明在了读得到的地方
 *
 * 与 `checkConfigPlace` 同一条道理，消灭的是另一种「写了却没反应」：样式表只从包
 * package.json 的 `webuiPanel.style` 读，于是模块里 `export const style` 什么都不会发生。
 * 单文件那一路根本没有 package.json，故它这条说的是「改成一个包」。
 *
 * **路径写坏了不在此处说**：那一种由 node 侧给出 `entry.styleError`（它查得到文件在不在）。
 * @param mod `import()` 得到的模块对象
 * @param entry 清单项
 * @returns 有问题时给出一句可示于包详情的原因，否则 undefined
 */
export function checkStylePlace(mod: unknown, entry: PanelEntry): string | undefined {
  const declared = isRecord(mod) && mod.style !== undefined
  if (!declared) return undefined

  if (entry.style !== undefined) {
    return "样式表已从 package.json 的 webuiPanel.style 读到，模块里的 style 导出不会被读取，请删掉它以免两处不一致"
  }
  if (entry.styleError !== undefined) return undefined

  return entry.kind === "multi"
    ? "自带样式表须在包 package.json 里写 webuiPanel.style 指向那份 .css；index.js 里的 style 导出不会被读取"
    : "单文件面板插件不支持自带样式表：那要由 node 侧读 package.json 才知道去取哪份 .css，而单个 .js 没有 package.json。需要自带样式请改成一个包（一个目录 + index.js + package.json），或在组件里用行内样式"
}
