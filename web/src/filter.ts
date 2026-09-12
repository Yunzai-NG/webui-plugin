/**
 * 模块职责：两个市场页共用的页签与「按分类、关键词筛」
 * 依赖方向：不依赖任何具体条目类型，按结构约束入参；纯函数
 * 生命周期：无状态
 * 注意事项：**抽出来是因为插件市场与面板商店筛的是同一件事、条目类型却不同。** 两处各写一遍的代价
 *          不是重复，而是**行为悄悄分叉** —— 一边把作者算进关键词、另一边不算，使用者搜作者名时
 *          只在一个市场里搜得到，而两个页面看起来一模一样。
 *
 *          入参按结构声明（`Filterable` / `Installable`）而非用泛型约束到某个具体类型：这几个函数
 *          只用到名称、标题、说明、作者、分类与两个安装状态，声明成结构即把这一事实写在类型里。
 *
 *          **页签也在此处**：内核市场此前只有「全部 / 已安装」，因为 `GET /api/market` 只给
 *          `installed` 一个布尔值，判不出可更新。内核已补上 `installedVersion` 与 `updatable`
 *          （与面板商店同一个 `compareVersion`），两边的页签语义于是完全相同 —— 那时再各写一份
 *          就是等着「角标说有 3 个、点进去只有 2 个」。
 */

/** 能被这几个函数筛的条目：两个市场的条目类型都满足 */
export interface Filterable {
  /** 包名或插件名 */
  name: string
  /** 展示标题 */
  title: string
  /** 一句话说明 */
  description: string
  /** 作者 */
  author?: string
  /** 分类标签 */
  tags: string[]
}

/** 带安装状态的条目，供页签判据 */
export interface Installable {
  /** 落点下是否已存在同名目录 */
  installed: boolean
  /** 索引里的版本是否高于已装那份；未装或任一侧读不到版本时为假 */
  updatable: boolean
}

/** 三个页签的标识，两个市场共用 */
export type MarketTab = "all" | "installed" | "updatable"

/**
 * 页签定义，顺序即呈现顺序
 *
 * **「全部」在最前且为默认** —— 还没装任何东西的人打开市场，该看到有什么可装，
 * 而不是一个空的「已安装」。
 */
export const MARKET_TABS: readonly { id: MarketTab; label: string }[] = [
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
export function inTab(item: Installable, tab: MarketTab): boolean {
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
export function tabCounts(items: readonly Installable[]): Record<MarketTab, number> {
  return {
    all: items.length,
    installed: items.filter(item => inTab(item, "installed")).length,
    updatable: items.filter(item => inTab(item, "updatable")).length
  }
}

/**
 * 按页签、分类与关键词筛一遍
 * @param items 全部条目
 * @param tab 当前页签
 * @param tags 选中的分类；空数组意为不按分类筛
 * @param keyword 关键词，空串意为不筛
 * @returns 可见条目
 */
export function visibleItems<T extends Filterable & Installable>(
  items: readonly T[],
  tab: MarketTab,
  tags: readonly string[],
  keyword: string
): T[] {
  return items.filter(item => inTab(item, tab) && matchesTags(item, tags) && matchesKeyword(item, keyword))
}

/**
 * 索引里出现过的全部分类，按出现次数降序、同次数按名称
 *
 * **分类做成一排可点的标签而非页签**：标签数由索引决定，十几个页签在窄屏上会折行，
 * 把「全部 / 已安装 / 可更新」这条主路挤到第二行。
 * @param items 全部条目
 * @returns 分类名数组
 */
export function tagsOf(items: readonly Filterable[]): string[] {
  const count = new Map<string, number>()
  for (const item of items) for (const tag of item.tags) count.set(tag, (count.get(tag) ?? 0) + 1)
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
}

/**
 * 这一条是否落在选中的分类里
 *
 * 分类为「或」而非「且」：勾了「监控」与「系统」两个标签，要的是这两类里的全部东西，
 * 而不是同时属于两类的那一小撮 —— 后者在一份手工维护的索引上几乎恒为空。
 * @param item 条目
 * @param tags 选中的分类；空数组意为不按分类筛
 * @returns 是否命中
 */
export function matchesTags(item: Filterable, tags: readonly string[]): boolean {
  if (tags.length === 0) return true
  return item.tags.some(tag => tags.includes(tag))
}

/**
 * 这一条是否命中关键词
 *
 * 名称、标题、说明、作者与分类一并搜：使用者记得的可能是其中任一项，而这五项都短，
 * 拼起来搜的代价可以忽略。
 * @param item 条目
 * @param keyword 关键词，空串意为不筛
 * @returns 是否命中
 */
export function matchesKeyword(item: Filterable, keyword: string): boolean {
  const word = keyword.trim().toLowerCase()
  if (word === "") return true
  const haystack = [item.name, item.title, item.description, item.author ?? "", ...item.tags].join(" ").toLowerCase()
  return haystack.includes(word)
}

/**
 * 切一个分类的选中状态
 *
 * 两个市场页各有一排可点标签，点击处理一模一样，故也收在此处。
 * @param picked 当前选中的分类
 * @param tag 被点的分类
 * @returns 新的选中数组
 */
export function toggleTag(picked: readonly string[], tag: string): string[] {
  return picked.includes(tag) ? picked.filter(item => item !== tag) : [...picked, tag]
}
