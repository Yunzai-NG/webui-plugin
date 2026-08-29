/**
 * 模块职责：面板插件商店的取数地址、页签筛选与「一次安装的结果该怎么说」
 * 依赖方向：只依赖本目录的类型声明，纯函数
 * 生命周期：无状态
 * 注意事项：抽出组件之外是为了能立断言 —— 用例只覆盖 `.ts`，`.vue` 里的逻辑无 jsdom 测不到。
 *          三处说错就会把使用者引向错动作：
 *
 *          1) **「装完之后该做什么」有三种答案，取决于包的形态。** 只有浏览器侧的包刷新
 *             页面即生效；带 node 侧的包要**重载 webui**（node 侧入口只在 webui 的
 *             `setup()` 里 import 一次）；还缺依赖的包要先装依赖再重载。说成一句「已安装」，
 *             使用者会刷新页面、看不到东西、以为装坏了。
 *          2) **「已是最新」不能说成「已更新」**（同内核那条，见 `market.ts`）：后者会让人
 *             转头去找那个并不存在的变化。
 *          3) **就地拉取与整目录重装的后果不同**：前者保住了 `node_modules`，后者那份依赖
 *             已随旧目录一起没了。
 */
import type { PanelStoreItem, PanelStoreResult } from "./types.js"

/** 商店端点，落在 webui 自己的 scope 下而非 `/api` 之内 */
const STORE_SCOPE = "/plugin/webui/panelstore"

/**
 * 商店的取数地址
 * @param path 子路径，省略即列表端点
 * @returns 绝对地址
 */
export function storeUrlOf(path = ""): string {
  return path === "" ? STORE_SCOPE : `${STORE_SCOPE}/${path}`
}

/** 三个页签的标识 */
export type StoreTab = "all" | "installed" | "updatable"

/**
 * 页签定义，顺序即呈现顺序
 *
 * **「全部」在最前且为默认** —— 还没装任何面板插件的人打开商店，该看到有什么可装，
 * 而不是一个空的「已安装」。
 */
export const STORE_TABS: readonly { id: StoreTab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "installed", label: "已安装" },
  { id: "updatable", label: "可更新" }
]

/**
 * 一条是否落在某个页签里
 * @param item 条目
 * @param tab 页签
 * @returns 是否可见
 */
export function inTab(item: PanelStoreItem, tab: StoreTab): boolean {
  if (tab === "installed") return item.installed
  if (tab === "updatable") return item.updatable
  return true
}

/**
 * 逐页签的条目数
 *
 * 角标里的数。**按同一个 `inTab` 算**，不另写一遍求和 —— 分两处写迟早对不上，
 * 症状是「角标说有 3 个，点进去只有 2 个」。
 * @param items 全部条目
 * @returns 页签标识到条目数
 */
export function tabCounts(items: readonly PanelStoreItem[]): Record<StoreTab, number> {
  return {
    all: items.length,
    installed: items.filter(item => inTab(item, "installed")).length,
    updatable: items.filter(item => inTab(item, "updatable")).length
  }
}

/**
 * 索引里出现过的全部分类，按出现次数降序、同次数按名称
 *
 * **分类做成一排可点的标签而非页签**：标签数由索引决定，十几个页签在窄屏上会折行，
 * 把「全部 / 已安装 / 可更新」这条主路挤到第二行。
 * @param items 全部条目
 * @returns 分类名数组
 */
export function tagsOf(items: readonly PanelStoreItem[]): string[] {
  const count = new Map<string, number>()
  for (const item of items) for (const tag of item.tags) count.set(tag, (count.get(tag) ?? 0) + 1)
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
}

/**
 * 按页签、分类与关键词筛一遍
 *
 * 分类为「或」而非「且」：勾了「监控」与「系统」两个标签，要的是这两类里的全部东西，
 * 而不是同时属于两类的那一小撮 —— 后者在一份手工维护的索引上几乎恒为空。
 * @param items 全部条目
 * @param tab 当前页签
 * @param tags 选中的分类；空数组意为不按分类筛
 * @param keyword 关键词，空串意为不筛
 * @returns 可见条目
 */
export function visibleItems(
  items: readonly PanelStoreItem[],
  tab: StoreTab,
  tags: readonly string[],
  keyword: string
): PanelStoreItem[] {
  const word = keyword.trim().toLowerCase()
  return items.filter(item => {
    if (!inTab(item, tab)) return false
    if (tags.length > 0 && !item.tags.some(tag => tags.includes(tag))) return false
    if (word === "") return true
    const haystack = [item.name, item.title, item.description, item.author ?? "", ...item.tags].join(" ").toLowerCase()
    return haystack.includes(word)
  })
}

/**
 * 版本一行怎么写
 *
 * 已装且索引更高时给「0.3.0 → 0.4.0」；已装且一致时只给一个数；未装时给索引里那个。
 * @param item 条目
 * @returns 版本文案
 */
export function versionText(item: PanelStoreItem): string {
  const indexed = item.version ?? "未声明"
  if (!item.installed) return indexed
  const local = item.installedVersion ?? "未知"
  return item.updatable ? `${local} → ${indexed}` : local
}

/**
 * 把一次安装或更新的结果说成一句话
 *
 * 三段拼起来：**这次做了什么**、**依赖怎么样**、**下一步该做什么**。第三段是本函数存在的
 * 主要理由 —— 见文件头第 1 条。
 * @param result 接口返回
 * @returns 提示文案
 */
export function storeResultText(result: PanelStoreResult): string {
  const did = didText(result)
  const dep = depText(result)
  const next = nextText(result)
  return [did, dep, next].filter(part => part !== "").join(" ")
}

/**
 * 第一段：这次到底做了什么
 * @param result 接口返回
 * @returns 文案
 */
function didText(result: PanelStoreResult): string {
  if (result.via === "pull") {
    if (result.changed === false) return `${result.name} 已是最新版本 ${result.version}，远端没有新提交。`
    const step =
      result.fromVersion === undefined || result.fromVersion === result.version
        ? result.version
        : `${result.fromVersion} → ${result.version}`
    return `${result.name} 已就地更新：${step}。目录内已装好的依赖未被动过。`
  }
  // 归档来源要顺带说一句「此后更新要整目录重下、依赖跟着重装」：
  // 那笔代价在装完的这一刻是隐形的，等第一次更新等了十分钟才发现就太晚了。git 来源是常态，不出声
  const cost = result.updatable === "reinstall" ? "此后的更新会整目录重下（该来源没有 git 仓库可供就地拉取）。" : ""
  return `${result.name} ${result.version} 已装到 ${result.dir}。${cost}`
}

/**
 * 第二段：依赖的状况
 *
 * 三种：跑过且成了、跑过但失败了、没跑而确实缺。**「没声明依赖」不出声** —— 那是多数
 * 面板插件的常态，为此多一句话只会淹掉真正要读的第三段。
 * @param result 接口返回
 * @returns 文案；无须出声时空串
 */
function depText(result: PanelStoreResult): string {
  if (result.installedDeps === true) return `依赖已由 ${result.packageManager ?? "包管理器"} 装好。`
  if (result.dependencyError !== undefined) {
    return `但依赖没装上（${result.dependencyError}），请在该目录内自行执行 pnpm install。`
  }
  if (result.needsDependencies) return `该包声明了运行时依赖，请在该目录内执行 pnpm install。`
  return ""
}

/**
 * 第三段：下一步该做什么
 *
 * 三种答案里最容易说错的一段。只有浏览器侧的包刷新页面即生效；带 node 侧的包要重载 webui；
 * 还缺依赖的包重载也没用 —— 它的 node 侧入口会 import 失败。
 * @param result 接口返回
 * @returns 文案
 */
function nextText(result: PanelStoreResult): string {
  if (result.via === "pull" && result.changed === false) return ""
  if (!result.hasServer) return "刷新页面即可看到它的组件。"
  if (result.needsDependencies) return "装完依赖后，到插件页重载 webui，它的 node 侧才会跑起来。"
  return "这个包带 node 侧，须到插件页重载 webui 才会生效 —— 只刷新页面不够。"
}
