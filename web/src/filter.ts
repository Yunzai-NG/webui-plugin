/**
 * 模块职责：两个市场页共用的页签，以及「按分类、关键词、首字母、作者、版本门与索引来源筛」
 * 依赖方向：不依赖任何具体条目类型，按结构约束入参；纯函数
 * 生命周期：无状态
 * 注意事项：**抽出来是因为插件市场与面板商店筛的是同一件事、条目类型却不同。** 两处各写一遍的代价
 *          不是重复，而是**行为悄悄分叉** —— 一边把作者算进关键词、另一边不算，使用者搜作者名时
 *          只在一个市场里搜得到，而两个页面看起来一模一样。
 *
 *          入参按结构声明（`Filterable` / `Installable`）而非用泛型约束到某个具体类型：这几个函数
 *          只用到名称、标题、说明、作者、分类、官方标记、来源与两个安装状态，声明成结构即把这一
 *          事实写在类型里。
 *
 *          **六道判据收进一个 `Criteria` 对象，不再逐个排成位置参数。** 从前是
 *          `visibleItems(items, tab, tags, keyword)`，再往后排四个就没人读得懂第六个实参是什么了；
 *          每一项都可省，故 `visibleItems(items, {})` 即「什么都不筛」。
 *
 *          **版本门那一项不认字段名。** 插件市场的门是 `minCore`、面板商店是 `minWebui`，由调用方
 *          传一个取值函数进来。在纯函数里认死某个字段名，等于让这两页只有一页筛得动。
 *
 *          **页签也在此处**：内核市场此前只有「全部 / 已安装」，因为 `GET /api/market` 只给
 *          `installed` 一个布尔值，判不出可更新。内核已补上 `installedVersion` 与 `updatable`
 *          （与面板商店同一个版本比较），两边的页签语义于是完全相同 —— 那时再各写一份
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
  /**
   * 是否官方维护
   *
   * 声明成可省的，好让用例的夹具不必逐条写上它 —— 缺失即按「非官方」算，
   * 那与两个市场的实际数据一致（两处都恒给这个布尔值）。
   */
  official?: boolean
  /** 条目来自哪个索引地址；配了多个索引源时才有筛的意义 */
  source?: string
}

/** 带安装状态的条目，供页签判据 */
export interface Installable {
  /** 落点下是否已存在同名目录 */
  installed: boolean
  /** 索引里的版本是否高于已装那份；未装或任一侧读不到版本时为假 */
  updatable: boolean
}

/** 四个页签的标识，两个市场共用 */
export type MarketTab = "all" | "notinstalled" | "installed" | "updatable"

/**
 * 页签定义，顺序即呈现顺序
 *
 * **「全部」在最前且为默认** —— 还没装任何东西的人打开市场，该看到有什么可装，
 * 而不是一个空的「已安装」。
 *
 * **「未安装」紧随其后。** 装了十几个插件之后，「还有什么能装」是最常用的视角，而此前
 * 只能用「全部」再自己跳过已装的那些。它与其余三个同为一维（互斥），故落在页签而不是
 * 筛选面板里。
 */
export const MARKET_TABS: readonly { id: MarketTab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "notinstalled", label: "未安装" },
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
  if (tab === "notinstalled") return !item.installed
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
    notinstalled: items.filter(item => inTab(item, "notinstalled")).length,
    installed: items.filter(item => inTab(item, "installed")).length,
    updatable: items.filter(item => inTab(item, "updatable")).length
  }
}

/* ─────────────────────────── 版本比较 ─────────────────────────── */

/**
 * 拆一个版本号成三段数字
 *
 * 容得下 `v1.2.3`、`>=0.2.0`、`^0.2` 这些写法：索引是手工维护的，前缀与位数都不齐。
 * 首段解不出数字时整个返回 undefined —— 那种字符串（`latest`、`main`）没有序，
 * 硬当成 0 会让它排在一切版本之前。
 * @param raw 版本号原文
 * @returns 三段数字；解不出时 undefined
 */
export function parseVersion(raw: string | undefined): [number, number, number] | undefined {
  if (raw === undefined) return undefined
  const bare = raw.trim().replace(/^[v=^~><\s]+/, "")
  const parts = bare.split(".").map(part => Number.parseInt(part, 10))
  if (parts.length === 0 || !Number.isFinite(parts[0] ?? Number.NaN)) return undefined
  return [parts[0] ?? 0, Number.isFinite(parts[1] ?? Number.NaN) ? (parts[1] ?? 0) : 0, Number.isFinite(parts[2] ?? Number.NaN) ? (parts[2] ?? 0) : 0]
}

/**
 * 比两个版本号
 *
 * **任一侧解不出时返回 0（视作相等）**，而不是把它排到某一端：解不出意味着「这个索引条目
 * 的版本写法我不认识」，此时任何排序都是编造。返回 0 的后果是它不会被版本门筛掉 ——
 * 宁可多显示一条，也不要凭一个没读懂的字符串把它藏起来。
 * @param a 版本一
 * @param b 版本二
 * @returns a 小于 b 时负数，大于时正数，相等或读不出时 0
 */
export function compareVersion(a: string | undefined, b: string | undefined): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === undefined || pb === undefined) return 0
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/* ─────────────────────────── 各维取值 ─────────────────────────── */

/**
 * 一条的首字母
 *
 * **按包名取而非标题**：标题多为中文，按中文首字挑不出「字母表」这种索引；而使用者在
 * 命令行里、在目录名里见到的都是英文包名。
 *
 * **scope 不算**：`@yunzai-ng/hardware-plugin` 的首字母是 H 而不是 Y —— 否则面板商店里
 * 同一个 scope 下的全部包会挤在同一个字母下，那个字母也就不再有筛选作用。
 * @param name 包名或插件名
 * @returns 大写字母；非字母开头时 `#`
 */
export function initialOf(name: string): string {
  const bare = name.replace(/^@[^/]+\//, "").trim()
  const first = bare.charAt(0).toUpperCase()
  return /^[A-Z]$/.test(first) ? first : "#"
}

/**
 * 索引里实际出现过的首字母，字母在前、`#` 在末
 *
 * **只列出现过的**，不摆一个 26 格的字母表：一份七条的索引只占得住七个字母，其余十九格
 * 点下去必然是空结果 —— 一个点了就空的按钮比没有这个按钮更糟。
 * @param items 全部条目
 * @returns 首字母数组
 */
export function initialsOf(items: readonly Filterable[]): string[] {
  const seen = new Set(items.map(item => initialOf(item.name)))
  const letters = [...seen].filter(one => one !== "#").sort((a, b) => a.localeCompare(b))
  return seen.has("#") ? [...letters, "#"] : letters
}

/** 一个维度上的可选项及其条目数 */
export interface FacetOption {
  /** 取值 */
  value: string
  /** 落在这个取值上的条目数 */
  count: number
}

/**
 * 索引里出现过的全部分类，按出现次数降序、同次数按名称
 *
 * **带上条目数**：「功能 4」比光写「功能」有用 —— 点之前就知道会剩多少，也顺手暴露了
 * 那些只有一条的标签。
 * @param items 全部条目
 * @returns 分类及其条目数
 */
export function tagFacets(items: readonly Filterable[]): FacetOption[] {
  const count = new Map<string, number>()
  for (const item of items) for (const tag of new Set(item.tags)) count.set(tag, (count.get(tag) ?? 0) + 1)
  return byCountThenName(count)
}

/**
 * 索引里出现过的分类名
 *
 * `tagFacets` 的名字部分。留着它是因为「有哪些分类」与「各有几条」是两个问题，
 * 而只问前者的调用处不该被迫解构一个对象。
 * @param items 全部条目
 * @returns 分类名数组
 */
export function tagsOf(items: readonly Filterable[]): string[] {
  return tagFacets(items).map(one => one.value)
}

/**
 * 索引里出现过的作者，按条目数降序
 *
 * 作者本来就在关键词的搜索范围里（见 `matchesKeyword`），单列一维仍然有用：搜索框要求
 * 使用者**先知道**名字，而这一排把「有哪些作者、各有几个」摆了出来。
 * @param items 全部条目
 * @returns 作者及其条目数
 */
export function authorFacets(items: readonly Filterable[]): FacetOption[] {
  const count = new Map<string, number>()
  for (const item of items) {
    const author = (item.author ?? "").trim()
    if (author === "") continue
    count.set(author, (count.get(author) ?? 0) + 1)
  }
  return byCountThenName(count)
}

/**
 * 索引里出现过的索引来源，按条目数降序
 *
 * 只配了一个索引源时这一维毫无用处（全部条目都来自它），故调用方在选项少于两个时
 * 整行不显示 —— 判断留在调用处，本函数照实回答「有哪几个来源」。
 * @param items 全部条目
 * @returns 来源地址及其条目数
 */
export function sourceFacets(items: readonly Filterable[]): FacetOption[] {
  const count = new Map<string, number>()
  for (const item of items) {
    const source = (item.source ?? "").trim()
    if (source === "") continue
    count.set(source, (count.get(source) ?? 0) + 1)
  }
  return byCountThenName(count)
}

/**
 * 按次数降序、同次数按名称升序
 * @param count 取值到条目数
 * @returns 排好的选项
 */
function byCountThenName(count: Map<string, number>): FacetOption[] {
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, num]) => ({ value, count: num }))
}

/**
 * 索引里声明过的版本门，升序
 *
 * 取值是条目声明的「最低需要的版本」。**升序而非降序**：这一列读起来像一根数轴，
 * 而数轴从小到大。
 * @param items 全部条目
 * @param gateOf 取一条声明的最低版本
 * @returns 版本号数组，已去重
 */
export function gatesOf<T>(items: readonly T[], gateOf: (item: T) => string | undefined): string[] {
  const seen = new Set<string>()
  for (const item of items) {
    const gate = (gateOf(item) ?? "").trim()
    if (gate !== "" && parseVersion(gate) !== undefined) seen.add(gate)
  }
  return [...seen].sort((a, b) => compareVersion(a, b))
}

/* ─────────────────────────── 逐项判据 ─────────────────────────── */

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
 * 这一条的首字母是否在选中的那几个里
 * @param item 条目
 * @param initials 选中的首字母；空数组意为不筛
 * @returns 是否命中
 */
export function matchesInitials(item: Filterable, initials: readonly string[]): boolean {
  if (initials.length === 0) return true
  return initials.includes(initialOf(item.name))
}

/**
 * 这一条的作者是否在选中的那几个里
 * @param item 条目
 * @param authors 选中的作者；空数组意为不筛
 * @returns 是否命中
 */
export function matchesAuthors(item: Filterable, authors: readonly string[]): boolean {
  if (authors.length === 0) return true
  return authors.includes((item.author ?? "").trim())
}

/**
 * 这一条是否来自选中的那几个索引
 * @param item 条目
 * @param sources 选中的来源；空数组意为不筛
 * @returns 是否命中
 */
export function matchesSources(item: Filterable, sources: readonly string[]): boolean {
  if (sources.length === 0) return true
  return sources.includes((item.source ?? "").trim())
}

/**
 * 版本门那一项的特殊取值：「当前这套装得上的」
 *
 * 与具体版本号放在同一个下拉里，故要一个不可能与版本号相撞的取值。
 */
export const FITS_GATE = "@fits"

/**
 * 这一条是否通过版本门
 *
 * 两种语义收在同一维里，因为它们互斥（选了一个就不会同时选另一个）：
 *
 * - `FITS_GATE`：**当前这套装得上的** —— 条目声明的最低版本不高于当前版本。没有声明门槛的
 *   条目算通过（它没提要求）；当前版本读不到时整项不筛，那时任何判断都是猜。
 * - 具体版本号：**声明的门槛在此值及以上**。没有声明门槛的条目**不**通过 —— 它压根没有
 *   「最低版本」这个属性，硬算通过会让「筛 0.4.0 及以上」的结果里混进一堆没声明的条目。
 * @param gate 选中的取值；空串意为不筛
 * @param declared 这一条声明的最低版本
 * @param current 当前内核 / 面板版本；读不到时 undefined
 * @returns 是否通过
 */
export function matchesGate(gate: string, declared: string | undefined, current: string | undefined): boolean {
  if (gate === "") return true
  const need = (declared ?? "").trim()

  if (gate === FITS_GATE) {
    if (need === "" || current === undefined || current.trim() === "") return true
    // 解不出的一侧让 compareVersion 给 0，于是照样通过 —— 见那个函数的注释
    return compareVersion(need, current) <= 0
  }

  if (need === "") return false
  return compareVersion(need, gate) >= 0
}

/* ─────────────────────────── 汇总 ─────────────────────────── */

/**
 * 六道判据
 *
 * 每一项都可省，缺省即「这一维不筛」。故 `{}` 是「什么都不筛」，而不是「什么都筛不出」。
 */
export interface Criteria {
  /** 当前页签，缺省为「全部」 */
  tab?: MarketTab
  /** 关键词 */
  keyword?: string
  /** 选中的分类 */
  tags?: readonly string[]
  /** 选中的首字母 */
  initials?: readonly string[]
  /** 选中的作者 */
  authors?: readonly string[]
  /** 版本门：空串不限，`FITS_GATE` 为「装得上」，否则为具体版本「及以上」 */
  gate?: string
  /** 选中的索引来源 */
  sources?: readonly string[]
  /** 只看官方维护的 */
  onlyOfficial?: boolean
}

/** 筛选时要用到的外部事实：怎么取版本门、当前版本是多少 */
export interface FilterContext<T> {
  /** 取一条声明的最低版本（插件市场是 `minCore`、面板商店是 `minWebui`） */
  gateOf?: (item: T) => string | undefined
  /** 当前内核 / 面板版本，供 `FITS_GATE` 那一项；读不到时该项不筛 */
  current?: string
}

/** 一切都不筛的那份判据，供「清空全部」 */
export function emptyCriteria(): Criteria {
  return { tab: "all", keyword: "", tags: [], initials: [], authors: [], gate: "", sources: [], onlyOfficial: false }
}

/**
 * 当前生效了几道判据
 *
 * 供收起态那枚按钮上的角标。**不数页签**：页签自己就摆在上面看得见，把它算进「筛选」
 * 按钮的角标里会让人以为面板里还藏着一项。同理不数关键词 —— 输入框里就写着。
 * @param criteria 判据
 * @returns 生效的道数
 */
export function activeCount(criteria: Criteria): number {
  /**
   * 一排选中项算不算一道
   * @param picked 该维选中的取值
   * @returns 选了东西时 1，否则 0
   */
  const one = (picked: readonly string[] | undefined): number => ((picked?.length ?? 0) > 0 ? 1 : 0)

  return (
    one(criteria.tags) +
    one(criteria.initials) +
    one(criteria.authors) +
    one(criteria.sources) +
    ((criteria.gate ?? "") === "" ? 0 : 1) +
    (criteria.onlyOfficial === true ? 1 : 0)
  )
}

/**
 * 按全部判据筛一遍
 * @param items 全部条目
 * @param criteria 判据；`{}` 意为什么都不筛
 * @param ctx 版本门的取法与当前版本
 * @returns 可见条目
 */
export function visibleItems<T extends Filterable & Installable>(
  items: readonly T[],
  criteria: Criteria = {},
  ctx: FilterContext<T> = {}
): T[] {
  const tab = criteria.tab ?? "all"
  /*
   * 没给取值函数时版本门整维不筛，而不是让每条都去撞 `matchesGate`
   *
   * 「这一页没接上这一维」与「这一条没声明门槛」是两件事，而 `matchesGate` 只答得了后者
   * （它按设计让没声明门槛的条目落选，见那个函数）。少了这一句，一个还没接版本门的调用处
   * 传进 `gate` 之后会筛掉全部条目 —— 页面上是一片空白，而每一条都还在索引里。
   */
  const gate = ctx.gateOf === undefined ? "" : (criteria.gate ?? "")
  const gateOf = ctx.gateOf
  return items.filter(
    item =>
      inTab(item, tab) &&
      matchesKeyword(item, criteria.keyword ?? "") &&
      matchesTags(item, criteria.tags ?? []) &&
      matchesInitials(item, criteria.initials ?? []) &&
      matchesAuthors(item, criteria.authors ?? []) &&
      matchesSources(item, criteria.sources ?? []) &&
      matchesGate(gate, gateOf?.(item), ctx.current) &&
      (criteria.onlyOfficial !== true || item.official === true)
  )
}

/**
 * 切一个取值的选中状态
 *
 * 分类、首字母、作者、来源四排都是「点一下选上、再点一下取消」，处理一模一样，
 * 故这一个函数供四处用 —— 它只认字符串数组，不在意里面装的是哪一维的取值。
 * @param picked 当前选中的取值
 * @param value 被点的取值
 * @returns 新的选中数组
 */
export function toggleTag(picked: readonly string[], value: string): string[] {
  return picked.includes(value) ? picked.filter(item => item !== value) : [...picked, value]
}
