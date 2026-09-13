/**
 * 模块职责：把插件自报的图标（整段 svg markup 或一段 path 数据）抠成面板能安全内联的几何数据
 * 依赖方向：无依赖，全为纯函数
 * 生命周期：纯函数，`mountCustomPages()` 加载每个插件时各调一次
 * 注意事项：**只取几何，其余一概丢掉。** 插件给的 markup 不原样进 DOM —— 那等于给每个插件
 *          一条 XSS 旁路（`<script>`、`onload=`、`<use href="...">`、`<foreignObject>` 里
 *          嫌 HTML），靠黑名单挡这些历来守不住。此处方向相反：只认白名单里的形状元素与
 *          它们的几何属性，认不出的元素、认不出的属性、任何 `on*`，全部落地成「没给图标」。
 *
 *          **颜色也在丢掉的那一堆里，那是特性不是限制。** 图标要跟着深浅主题变色，故
 *          `stroke` / `fill` / `stroke-width` 一律归面板的 svg 外壳所有（见 AppIcon.vue：
 *          统一描边 + `currentColor`）。留着插件写的 `fill="#333"`，深色主题下它就是一团黑。
 *
 *          **几何数据随 `custom-pages` 一起回来，不做成静态资源。** 后者要多一个挂载、每个
 *          图标多一次请求，且静态资源按既定取舍是不要令牌的 —— 那会把插件目录名连同一个
 *          可探测的 URL 一起露出去。内联则搭已有的那一次带令牌请求，反代与远程访问下
 *          与本机一致。
 */

/**
 * 一枚图标的几何数据，逐元素给出
 *
 * 不并成一段 path 字符串：`circle` 与 `rect` 化成 path 要自己算贝塞尔与圆角，
 * 算错了图标会歪，而前端照原样渲染这几个元素本就不难。
 */
export interface IconShape {
  /** 元素名，取值必在 `SHAPES` 之内 */
  readonly tag: string
  /** 该元素的几何属性，键必在 `SHAPES[tag]` 之内 */
  readonly attrs: Readonly<Record<string, string>>
}

/**
 * 允许内联的形状元素及各自的几何属性
 *
 * 这份表就是白名单本身。**`<use>` 不在其中**：它能引用外部文档（`href="//evil/x#y"`），
 * 是 svg 里最容易被忽略的那条取数据的路。`<image>`、`<foreignObject>`、`<script>`、
 * `<style>`、`<animate>` 同理，一律不认。
 */
const SHAPES: Readonly<Record<string, readonly string[]>> = {
  path: ["d"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"]
}

/**
 * 单枚图标最多收几个形状元素
 *
 * 24×24 的线稿图标用不了这么多；上限在此是为了不让一份几万个 `<path>` 的 svg
 * （地图、字体轮廓这类）经由 `custom-pages` 送到每一个打开面板的浏览器上。
 */
const MAX_SHAPES = 24

/** 单个几何属性值的长度上限，`d` 也在其内 */
const MAX_ATTR = 4096

/**
 * 几何属性值允许出现的字符
 *
 * 数字、空白、逗号、正负号、小数点、指数记号 `e`，以及 path 命令字母。**不含括号、引号、
 * 分号与冒号**：`url(...)`、`javascript:`、`;` 分隔的样式串都因此进不来，故这一层过后
 * 值可以直接作为属性写出去。
 */
const GEOMETRY_RE = /^[\s\d,.+\-eE%aAcChHlLmMqQsStTvVzZ]*$/

/** 从一段 markup 里逐个抠出元素：名字 + 属性串 */
const ELEMENT_RE = /<\s*([a-zA-Z][a-zA-Z0-9-]*)\s*([^>]*?)\/?\s*>/g

/**
 * 从一段属性串里逐个抠出 `名字="值"`，单双引号都收
 *
 * 名字部分必须容得下数字：`line` 的四个几何属性是 `x1` `y1` `x2` `y2`，写成
 * `[a-zA-Z-]+` 的话 `x1` 匹配不上（停在 `x`，之后要 `=` 却遇到 `1`），
 * 于是整个 `<line>` 一个属性都抠不出来，被当成空元素丢掉 —— 表现为
 * 「图标里的直线没了」，其余形状照画。
 */
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*("([^"]*)"|'([^']*)')/g

/**
 * 看起来像一整段 svg markup 吗
 *
 * 判据取「含尖括号」而非「以 `<svg` 开头」：插件可能只给一段 `<path d="..."/>`，
 * 或在前面留了 XML 声明与注释。两者都该走抠元素那条路，而不是被当成一段 `d`。
 * @param raw 插件自报的图标
 * @returns 像 markup 则为真
 */
function looksLikeMarkup(raw: string): boolean {
  return raw.includes("<")
}

/**
 * 一段 path 数据是否可用作 `d`
 *
 * 除字符集外还要求**含至少一个 moveto**：`d="12"` 过得了字符集这一关，画出来却是空的，
 * 而一个不显示的图标与「没给图标」在使用者眼里没有区别 —— 后者会回落到默认图标，
 * 前者则是一块空白。故这一步把它归到「没给」那一类。
 * @param d path 数据
 * @returns 可用则为真
 */
function isUsablePathData(d: string): boolean {
  return d.length <= MAX_ATTR && GEOMETRY_RE.test(d) && /[mM]/.test(d)
}

/**
 * 抠出一个元素的几何属性
 *
 * 白名单之外的属性一律丢掉，其中包括 `on*` 与 `style`。**丢掉不等于放行整个元素**：
 * 见 `parseIcon` —— 一个元素若连一个几何属性都没剩下，它本身也不会被收下。
 * @param tag 元素名，已确认在 `SHAPES` 内
 * @param attrText 该元素的属性串
 * @returns 几何属性；含不合法取值时 undefined
 */
function attrsOf(tag: string, attrText: string): Record<string, string> | undefined {
  const allowed = SHAPES[tag] ?? []
  const out: Record<string, string> = {}
  for (const match of attrText.matchAll(ATTR_RE)) {
    const name = (match[1] ?? "").toLowerCase()
    if (!allowed.includes(name)) continue
    const value = (match[3] ?? match[4] ?? "").trim()
    /*
     * 取值不合法即整枚图标作废，不是「跳过这一条属性」
     *
     * 少一个 `cx` 的圆会画到左上角去，少一个 `r` 的圆干脆不出现 —— 都是「图标显示成了
     * 别的样子」，比回落到默认图标更难查。宁可判成没给。
     */
    if (value.length > MAX_ATTR || !GEOMETRY_RE.test(value)) return undefined
    if (value === "") continue
    out[name] = value
  }
  return out
}

/**
 * 把插件自报的图标解析为可内联的几何数据
 *
 * 两种入参都收：整段 svg markup（含 `<`），或一段裸 path 数据。**认不出一律返回
 * undefined，由调用方回落到默认图标** —— 一个插件把图标写错了，代价该止于「它那一项
 * 用的是通用图标」，而不是导航上多一块空白，更不该是整个页面注册失败。
 * @param raw 插件自报的图标，非字符串时视为没给
 * @returns 几何数据；不可用时 undefined
 */
export function parseIcon(raw: unknown): readonly IconShape[] | undefined {
  if (typeof raw !== "string") return undefined
  const text = raw.trim()
  if (text === "") return undefined

  if (!looksLikeMarkup(text)) {
    return isUsablePathData(text) ? [{ tag: "path", attrs: { d: text } }] : undefined
  }

  const shapes: IconShape[] = []
  for (const match of text.matchAll(ELEMENT_RE)) {
    const tag = (match[1] ?? "").toLowerCase()
    // `<svg>` 自己与 `<g>` 只是容器，跳过而不作废：内容在它们的子元素里。
    // 注意 `<g transform="...">` 的位移就此丢失 —— 那是有意的，`transform` 能把图形
    // 挪到 24×24 视框之外，而带 transform 的图标本就该由作者自己压平。
    if (tag === "svg" || tag === "g" || tag === "defs" || tag === "title" || tag === "desc") continue
    if (SHAPES[tag] === undefined) return undefined
    const attrs = attrsOf(tag, match[2] ?? "")
    if (attrs === undefined) return undefined
    // 一个几何属性都没剩下的形状画不出东西，且往往意味着它的几何写在 `style` 或
    // `transform` 里 —— 那两样都被丢掉了，收下它只会得到一个看不见的元素
    if (Object.keys(attrs).length === 0) continue
    if (tag === "path" && !isUsablePathData(attrs.d ?? "")) return undefined
    if (shapes.length >= MAX_SHAPES) return undefined
    shapes.push({ tag, attrs })
  }
  return shapes.length === 0 ? undefined : shapes
}
