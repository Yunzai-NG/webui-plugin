/**
 * 模块职责：面板组件注册表 —— 谁挂在哪一页、默认占多大、由哪个 vue 组件渲染
 * 依赖方向：只依赖 vue 的 `Component` 类型与 grid 的 `WidgetSpec`；不认识任何具体页面
 * 生命周期：模块级单例，注册在模块加载时完成
 * 注意事项：内置组件、面板插件组件、配置组件共用这一张表，故编辑态对三者一律生效。
 *
 *          **同一标识不允许后注册者覆盖前者**：覆盖会使「这一格里究竟是什么」取决于
 *          目录里的文件名排序。重复注册记一条 error 并忽略后者。
 *
 *          **注册顺序即默认版面顺序**（没有落盘布局时按此顺序补空位），故内置组件的
 *          注册顺序不可随手调整 —— 否则升级一次面板，使用者眼里是「卡片自己重排了」。
 */
import type { Component } from "vue"
import type { WidgetSpec } from "./grid.js"
import type { PanelMeta } from "./panelcheck.js"

/** 一个可摆放的组件 */
export interface WidgetDef {
  /** 全站唯一的标识；落盘的布局按它认位置，故改名等于换一个组件 */
  id: string
  /** 挂到哪一页，取 `ROUTES` 中的 id */
  page: string
  /** 组件名，在编辑态的把手与「添加组件」里显示 */
  title: string
  /** 来源：面板自身或面板插件 */
  source: "builtin" | "plugin"
  /** 默认尺寸与下限 */
  layout: {
    /** 默认列数 */
    w: number
    /** 默认行数 */
    h: number
    /** 最少列数，缺省 1；`resizable` 为真时必须给出（否则能拖到一列宽） */
    minW?: number
    /** 最少行数，缺省 1；`resizable` 为真时必须给出，理由同 `minW` */
    minH?: number
    /** 使用者是否可改这一格的大小，缺省为假；详见 `grid.ts` 的 `WidgetSpec.resizable` */
    resizable?: boolean
  }
  /** 渲染它的 vue 组件 */
  component: Component
  /** 传给该组件的 props；同一个组件注册多次时以此区分 */
  props?: Record<string, unknown>
  /**
   * 是否默认不上板，改为出现在编辑态的「已移除」一栏里
   *
   * 为「多数机器上取不到数据」的组件而设（显卡即是：nvidia-smi 在 AMD、Intel、Termux
   * 上一概没有），免得默认给多数人一格永远测不到的东西。
   */
  defaultHidden?: boolean
  /** 面板插件的自报信息，供插件页显示版本、说明、仓库与作者；内置组件没有这一项 */
  meta?: PanelMeta
  /** 单文件还是多文件；仅面板插件有，示于插件页 */
  kind?: "single" | "multi"
  /**
   * 装载失败的原因；仅占位格有
   *
   * 单独记一份，不由 `meta` 的有无反推：语法错到没解析出模块与解析成功却少写 `meta`
   * 都会导致 meta 为空，而使用者要做的事不同（看语法 / 补一段导出）。
   */
  failure?: string
  /** 这一格来自哪个文件，形如 `panels/clock.js`；仅面板插件有 */
  from?: string
  /**
   * 这一枚属于哪个包，形如 `panels/hardware`（多文件）或 `panels/clock.js`（单文件）
   *
   * 与 `from` 的分工：那个给人看，这个给程序用。插件页按它把同一个包的组件归成一张
   * 卡片 —— 拆 `from` 的文本反推包名等于拿显示用的字符串当数据来源，改一次标签格式
   * 归并就失效且不报错。由 `packageKeyOf` 算出。
   */
  pkg?: string
}

const REGISTRY: WidgetDef[] = []

/**
 * 注册一个组件
 * @param def 组件定义
 * @returns 是否注册成功；标识重复时为 false
 */
export function registerWidget(def: WidgetDef): boolean {
  if (REGISTRY.some(item => item.id === def.id)) {
    console.error(`面板组件 ${def.id} 已注册，本次注册被忽略`)
    return false
  }
  REGISTRY.push(def)
  return true
}

/**
 * 取某一页的全部组件，顺序即注册顺序
 * @param page 页面标识
 * @returns 该页的组件定义
 */
export function widgetsOf(page: string): WidgetDef[] {
  return REGISTRY.filter(item => item.page === page)
}

/**
 * 取全部面板插件组件，**跨页**，顺序即注册顺序
 *
 * 与 `widgetsOf` 分开：插件页要回答的是「这台机器上装了哪些面板插件」，与它们各自挂在
 * 哪一页无关。装载失败的占位格也在其中（同为 `source: "plugin"`）—— 概览页上一格红字
 * 只说「这个坏了」，而插件页能说清是哪个文件。
 * @returns 面板插件的组件定义
 */
export function panelWidgets(): WidgetDef[] {
  return REGISTRY.filter(item => item.source === "plugin")
}

/** 插件页上的一张包卡片 */
export interface PanelPackageView {
  /** 包键，形如 `panels/hardware`；由 `packageKeyOf` 算出 */
  key: string
  /** 显示名，即包键去掉归属那一段 */
  name: string
  /** 单文件还是多文件；同一个包的各枚组件形态一致，故取组内第一个 */
  kind?: "single" | "multi"
  /** 自报信息；取组内第一个非空 */
  meta?: PanelMeta
  /** 其下全部组件，含失败的占位格，顺序即注册顺序 */
  widgets: WidgetDef[]
  /** 其中装载失败的那些 */
  failures: WidgetDef[]
  /** 这个包贡献的插件页页签 */
  tabs: TabDef[]
}

/**
 * 按包归并全部面板插件组件，供插件页「一个包一张卡片」
 *
 * **归并键取 `pkg` 而非 `from`**，理由见 `WidgetDef.pkg`。没有 `pkg` 的各自成一行、用 id
 * 兜底 —— 归并不到时宁可多出一张卡片，也不该把互不相干的包并成一张。
 *
 * `meta` 与 `kind` 取组内第一个非空（同一个包的各枚本就共用一份，失败的占位格两项皆无）。
 * 顺序即注册顺序，故插件页上卡片的先后稳定。
 * @returns 每个包一行
 */
export function panelPackages(): PanelPackageView[] {
  const out: PanelPackageView[] = []
  const byKey = new Map<string, PanelPackageView>()

  for (const widget of panelWidgets()) {
    const key = widget.pkg ?? widget.id
    let row = byKey.get(key)
    if (row === undefined) {
      row = {
        key,
        name: key.includes("/") ? key.slice(key.indexOf("/") + 1) : key,
        widgets: [],
        failures: [],
        tabs: panelTabsOf(key)
      }
      byKey.set(key, row)
      out.push(row)
    }
    row.widgets.push(widget)
    if (widget.failure !== undefined) row.failures.push(widget)
    if (row.kind === undefined && widget.kind !== undefined) row.kind = widget.kind
    if (row.meta === undefined && widget.meta !== undefined) row.meta = widget.meta
  }

  /*
   * 只出页签、一枚组件都没有的包也要有一张卡片
   *
   * 上面那一轮按组件归并，故这种包会整张卡片消失 —— 而它明明装上了、页签也在。
   */
  for (const tab of TABS) {
    if (byKey.has(tab.pkg)) continue
    const row: PanelPackageView = {
      key: tab.pkg,
      name: tab.pkg.includes("/") ? tab.pkg.slice(tab.pkg.indexOf("/") + 1) : tab.pkg,
      widgets: [],
      failures: [],
      tabs: panelTabsOf(tab.pkg)
    }
    byKey.set(tab.pkg, row)
    out.push(row)
  }

  return out
}

/** 一个由面板插件贡献的插件页页签 */
export interface TabDef {
  /** 全站唯一标识 */
  id: string
  /** 页签上的文案 */
  title: string
  /** 哪个包贡献的，形如 `panels/hardware` */
  pkg: string
  /** 渲染它的 vue 组件 */
  component: Component
}

const TABS: TabDef[] = []

/**
 * 注册一个插件页页签
 *
 * **同标识不许后注册者覆盖，规则同 `registerWidget`。**
 * @param def 页签定义
 * @returns 是否注册成功；标识重复时为 false
 */
export function registerTab(def: TabDef): boolean {
  if (TABS.some(item => item.id === def.id)) {
    console.error(`插件页页签 ${def.id} 已注册，本次注册被忽略`)
    return false
  }
  TABS.push(def)
  return true
}

/**
 * 取全部插件贡献的页签，顺序即注册顺序
 * @returns 页签定义
 */
export function panelTabs(): TabDef[] {
  return [...TABS]
}

/**
 * 取某个包贡献的页签
 * @param pkg 包键
 * @returns 该包的页签定义
 */
export function panelTabsOf(pkg: string): TabDef[] {
  return TABS.filter(item => item.pkg === pkg)
}

/**
 * 取某一页组件的栅格约束，供 `grid.ts` 计算位置
 *
 * 下限缺省取 1，但这个缺省值**只对不可调的组件生效**（那时 `clampSlot` 一律取声明的
 * `w` / `h`）。可调的组件必须自己给出下限，校验见 `panelcheck.ts`；`?? 1` 只是
 * 「校验漏过一个」时仍有个能算的数，不是可调组件的默认下限。
 * @param page 页面标识
 * @returns 该页组件的栅格约束，顺序同 `widgetsOf`
 */
export function specsOf(page: string): WidgetSpec[] {
  return widgetsOf(page).map(item => ({
    id: item.id,
    w: item.layout.w,
    h: item.layout.h,
    minW: item.layout.minW ?? 1,
    minH: item.layout.minH ?? 1,
    ...(item.layout.resizable === true ? { resizable: true } : {}),
    ...(item.defaultHidden === true ? { defaultHidden: true } : {})
  }))
}
