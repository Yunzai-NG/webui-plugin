/**
 * 模块职责：把一个包自带的样式表限定到这个包自己的地盘，再注入页面
 * 依赖方向：限定那半是纯字符串处理，不依赖任何浏览器 API（故可在 node 环境下跑用例）；
 *          注入那半只碰 `document`
 * 生命周期：装载期由 `panelload.ts` 对每个声明了样式表的包各调一次
 * 注意事项：**不限定就是全局。** 一个包写 `.card { padding: 0 }`，改的是整个面板的卡片；
 *          原样注入等于让任何一个包都能改坏别人的组件与面板自身，而这种坏法查起来极难 ——
 *          页面某处忽然变了样，源头却在一个与它无关的插件里。故每条选择器都前置
 *          `[data-panel="<包键>"]`，而那个属性由栅格里的格子（`GridBoard.vue` 的 `.witem`）
 *          与插件页的页签容器（`PluginsView.vue`）带上。
 *
 *          **`:root` 改写为包自己的容器，而不是前置。** 前置得到的 `[data-panel] :root`
 *          永不匹配（`:root` 是文档根），于是作者写在 `:root` 里的那些自定义属性一个都不生效 ——
 *          而在包内声明变量本是最常见的写法。`html` 与 `body` 同理。
 *
 *          **`@keyframes` 内部不能动。** 里面是 `0%` / `from` 这些关键帧选择器，前置之后
 *          整段动画失效；而动画名本就是全局的，重名由作者自己避开（文档里写明加前缀）。
 *
 *          注入失败**不废掉这个包**：样式没加载是「长得不对」，组件本身照常能用，
 *          比连数据都看不到要好。故只在控制台出声。
 */

/** 可以套住其它规则、须递归进去限定的 at-rule */
const NESTED_AT = new Set(["media", "supports", "container", "layer", "scope"])

/** 一律原样放行的选择器：它们指的是文档根或页面，前置反而永不匹配 */
const ROOT_SELECTORS = new Set([":root", "html", "body", ":host"])

/**
 * 一个包的地盘选择器
 *
 * 包键的字符已由 node 侧的 `isSafeName` 限定在 `[A-Za-z0-9._-]` 与一个斜杠之内，
 * 故直接放进引号里，不必转义。
 * @param pkg 包键，形如 `panels/hardware`
 * @returns 形如 `[data-panel="panels/hardware"]`
 */
export function scopeSelectorOf(pkg: string): string {
  return `[data-panel="${pkg}"]`
}

/**
 * 去掉注释
 *
 * 先去掉再解析，免得 `/* … { … *\/` 里的花括号让下面的配对乱掉。字符串内的
 * `/*` 不算注释起点（`url("a/*b")` 是合法的），故扫描时要跟着引号状态走。
 * @param css 样式表文本
 * @returns 去掉注释后的文本
 */
export function stripComments(css: string): string {
  let out = ""
  let quote = ""
  let i = 0
  while (i < css.length) {
    const ch = css[i] ?? ""
    if (quote !== "") {
      out += ch
      // 反斜杠转义：跳过下一个字符，否则 `"\""` 会被当成字符串结束
      if (ch === "\\" && i + 1 < css.length) {
        out += css[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = ""
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2)
      // 没有收尾的注释：其后全是注释内容，就此作罢
      if (end === -1) break
      i = end + 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * 找出与 `open` 处那个 `{` 配对的 `}`
 *
 * 字符串里的花括号不计数：`content: "}"` 是合法的，按字符数会让整份样式表从那里裂开。
 * @param css 样式表文本，已去过注释
 * @param open `{` 的下标
 * @returns `}` 的下标；没有配对的收尾时为文本长度
 */
function matchBrace(css: string, open: number): number {
  let depth = 0
  let quote = ""
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i] ?? ""
    if (quote !== "") {
      if (ch === "\\") {
        i += 1
        continue
      }
      if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return css.length
}

/**
 * 按逗号切开一串选择器
 *
 * 不能直接 `split(",")`：`:is(.a, .b)` 与 `:has(> .c, .d)` 里的逗号属于括号内部，
 * 切开之后得到的是两条语法错误的选择器，而浏览器会把整条规则丢掉。
 * @param list 选择器列表，如 `.a, .b:is(.c, .d)`
 * @returns 逐条选择器
 */
export function splitSelectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ""
  let current = ""
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i] ?? ""
    if (quote !== "") {
      current += ch
      if (ch === "\\" && i + 1 < list.length) {
        current += list[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === "(" || ch === "[") depth += 1
    else if (ch === ")" || ch === "]") depth -= 1
    if (ch === "," && depth === 0) {
      out.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  const last = current.trim()
  if (last !== "") out.push(last)
  return out.filter(item => item !== "")
}

/**
 * 把一条选择器限定到一个包的地盘
 *
 * `:root` / `html` / `body` / `:host` 一族**改写为地盘本身**而不是前置，理由见文件头。
 * 其余一律前置一层后代关系。
 * @param selector 一条选择器
 * @param scope 地盘选择器
 * @returns 限定后的选择器
 */
export function scopeOneSelector(selector: string, scope: string): string {
  const trimmed = selector.trim()
  if (trimmed === "") return ""
  if (ROOT_SELECTORS.has(trimmed)) return scope

  // `:root .foo` 一类：换掉打头那一节，`.foo` 仍是地盘内的后代
  for (const root of ROOT_SELECTORS) {
    if (trimmed.startsWith(`${root} `)) return `${scope} ${trimmed.slice(root.length).trim()}`
    if (trimmed.startsWith(`${root}>`)) return `${scope}${trimmed.slice(root.length)}`
  }
  return `${scope} ${trimmed}`
}

/**
 * 限定一整段样式表
 *
 * 逐条规则处理：普通规则限定它的选择器；`@media` 一族递归进去（它们套的是规则，
 * 限定要落在里层那些选择器上）；`@keyframes` / `@font-face` 一族原样保留，理由见文件头。
 * @param css 样式表文本，已去过注释
 * @param scope 地盘选择器
 * @returns 限定后的样式表
 */
function scopeBlock(css: string, scope: string): string {
  const out: string[] = []
  let i = 0
  while (i < css.length) {
    const brace = css.indexOf("{", i)
    if (brace === -1) {
      // 没有花括号了：剩下的是 `@charset "x";` 一类没有块的语句，或末尾的空白
      const rest = css.slice(i).trim()
      if (rest !== "") out.push(rest)
      break
    }

    const semi = css.indexOf(";", i)
    if (semi !== -1 && semi < brace) {
      // 无块的 at-rule（`@import`、`@charset`）：原样保留，它们与选择器无关
      const stmt = css.slice(i, semi + 1).trim()
      if (stmt !== "") out.push(stmt)
      i = semi + 1
      continue
    }

    const prelude = css.slice(i, brace).trim()
    const close = matchBrace(css, brace)
    const body = css.slice(brace + 1, close)
    i = close + 1

    if (prelude.startsWith("@")) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? ""
      out.push(NESTED_AT.has(name) ? `${prelude} {\n${scopeBlock(body, scope)}\n}` : `${prelude} {${body}}`)
      continue
    }

    const selectors = splitSelectors(prelude).map(item => scopeOneSelector(item, scope))
    if (selectors.length === 0) continue
    out.push(`${selectors.join(", ")} {${body}}`)
  }
  return out.join("\n")
}

/**
 * 把一份样式表限定到一个包的地盘
 *
 * 这是本模块的入口，也是唯一有必要单独测的一半：算错不会报错，只表现为「样式没生效」
 * 或更糟的「改到了面板别处」。
 * @param css 包自带的样式表文本
 * @param pkg 包键，形如 `panels/hardware`
 * @returns 限定后的样式表
 */
export function scopePanelCss(css: string, pkg: string): string {
  return scopeBlock(stripComments(css), scopeSelectorOf(pkg))
}

/**
 * 取一个包的样式表，限定后注入 `<head>`
 *
 * **用 `fetch` 取文本再注入，而不是插一个 `<link>`。** 限定要改写选择器，而那要求先拿到
 * 文本 —— `<link>` 进来的是浏览器直接生效的全局样式，改不动了。
 *
 * 代价是每个带样式表的包多一趟往返。那与限定无关（插 `<link>` 同样要下载一次），
 * 且与该包的 `import()` 并发，故不额外拖慢装载。
 *
 * **`document` 只在函数体里碰**，模块级不碰任何浏览器 API：限定那半的用例跑在 node 环境
 * （无 jsdom），模块级读一次 `document` 就整个文件都不能测了。
 * @param pkg 包键，形如 `panels/hardware`
 * @param url 样式表地址，由 node 侧经清单给出
 * @returns 无；失败只在控制台出声，不抛错
 */
export async function loadPanelStyle(pkg: string, url: string): Promise<void> {
  let css: string
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    css = await res.text()
  } catch (err) {
    // 不废掉这个包：样式没加载是「长得不对」，组件本身照常能用
    console.error(`面板插件 ${pkg} 的样式表 ${url} 取不到，本包此次没有自带样式`, err)
    return
  }

  const el = document.createElement("style")
  el.dataset.panel = pkg
  el.textContent = scopePanelCss(css, pkg)
  document.head.append(el)
}
