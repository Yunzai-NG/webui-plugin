/**
 * 模块职责：`panelstyle.ts` 限定那半的用例 —— 选择器前置、`:root` 改写、嵌套 at-rule
 * 依赖方向：测试文件，只依赖被测模块的纯函数那一半（`loadPanelStyle` 碰 `document`，不在此测）
 * 生命周期：纯函数，无夹具
 * 注意事项：**这里的每一条都是「算错了不报错」。** 限定漏了一条，那条规则就成了全局的 ——
 *          一个插件的 `.card { }` 改掉整个面板的卡片，而症状出现的地方与源头毫无关联；
 *          限定多了一层，样式只是不生效，作者会以为自己的 css 写错了。两种都不抛异常。
 *
 *          尤其钉住 `:root`：前置得到的 `[data-panel] :root` 永不匹配，于是作者在包内
 *          声明的自定义属性一个都不生效 —— 而那是最常见的写法。
 */
import { describe, expect, it } from "vitest"
import { scopeOneSelector, scopePanelCss, scopeSelectorOf, splitSelectors, stripComments } from "./panelstyle.js"

const PKG = "panels/hardware"
const SCOPE = `[data-panel="${PKG}"]`

describe("地盘选择器", () => {
  it("包键原样进属性选择器 —— 字符已由 node 侧限定，不必转义", () => {
    expect(scopeSelectorOf(PKG)).toBe(SCOPE)
    expect(scopeSelectorOf("panels/clock.js")).toBe('[data-panel="panels/clock.js"]')
  })
})

describe("去注释", () => {
  it("整段去掉", () => {
    expect(stripComments("a{b:1}/* x */c{d:2}")).toBe("a{b:1}c{d:2}")
  })

  it("**注释里的花括号不算数** —— 否则下面的配对会从这里裂开", () => {
    expect(stripComments("a{/* } */b:1}")).toBe("a{b:1}")
  })

  it("字符串里的 /* 不是注释起点 —— `url(\"a/*b\")` 是合法的", () => {
    expect(stripComments('a{background:url("x/*y")}')).toBe('a{background:url("x/*y")}')
  })

  it("没有收尾的注释：其后全当注释，不把残句留给解析", () => {
    expect(stripComments("a{b:1}/* 忘了收尾")).toBe("a{b:1}")
  })
})

describe("切分选择器", () => {
  it("顶层逗号切开", () => {
    expect(splitSelectors(".a, .b")).toEqual([".a", ".b"])
  })

  it("**括号内的逗号不切** —— 切了得到两条语法错误的选择器，整条规则被浏览器丢掉", () => {
    expect(splitSelectors(".a:is(.b, .c), .d")).toEqual([".a:is(.b, .c)", ".d"])
    expect(splitSelectors('[data-x="1,2"], .e')).toEqual(['[data-x="1,2"]', ".e"])
  })

  it("空段落丢掉，尾随逗号不产生空选择器", () => {
    expect(splitSelectors(".a, , .b,")).toEqual([".a", ".b"])
  })
})

describe("限定一条选择器", () => {
  it("普通选择器前置一层后代关系", () => {
    expect(scopeOneSelector(".card", SCOPE)).toBe(`${SCOPE} .card`)
  })

  it("**`:root` 改写为地盘本身，不是前置** —— 前置得到的 `[data-panel] :root` 永不匹配", () => {
    expect(scopeOneSelector(":root", SCOPE)).toBe(SCOPE)
    expect(scopeOneSelector("html", SCOPE)).toBe(SCOPE)
    expect(scopeOneSelector("body", SCOPE)).toBe(SCOPE)
  })

  it("`:root .foo` 换掉打头那一节，后代关系仍在", () => {
    expect(scopeOneSelector(":root .foo", SCOPE)).toBe(`${SCOPE} .foo`)
    expect(scopeOneSelector("body>.foo", SCOPE)).toBe(`${SCOPE}>.foo`)
  })

  it("`.rooted` 不被当成 `:root` 的前缀误伤", () => {
    expect(scopeOneSelector(".rooted", SCOPE)).toBe(`${SCOPE} .rooted`)
  })
})

describe("限定一整份样式表", () => {
  it("每条规则各自限定", () => {
    const out = scopePanelCss(".a{color:red}.b{color:blue}", PKG)
    expect(out).toContain(`${SCOPE} .a {color:red}`)
    expect(out).toContain(`${SCOPE} .b {color:blue}`)
  })

  it("一条规则的多个选择器逐个限定 —— 漏掉后半截，后半截就是全局的", () => {
    expect(scopePanelCss(".a, .b{color:red}", PKG)).toBe(`${SCOPE} .a, ${SCOPE} .b {color:red}`)
  })

  it("`:root` 里的自定义属性落在地盘上，故包内变量确实可用", () => {
    expect(scopePanelCss(":root{--x:1px}", PKG)).toBe(`${SCOPE} {--x:1px}`)
  })

  it("**`@media` 递归进去** —— 限定要落在里层的选择器上，不是套在 at-rule 外面", () => {
    const out = scopePanelCss("@media (min-width: 600px){.a{color:red}}", PKG)
    expect(out).toContain("@media (min-width: 600px) {")
    expect(out).toContain(`${SCOPE} .a {color:red}`)
  })

  it("`@container` / `@supports` / `@layer` 同样递归", () => {
    expect(scopePanelCss("@supports (display: grid){.a{color:red}}", PKG)).toContain(`${SCOPE} .a`)
    expect(scopePanelCss("@container (min-width: 20em){.a{color:red}}", PKG)).toContain(`${SCOPE} .a`)
    expect(scopePanelCss("@layer x{.a{color:red}}", PKG)).toContain(`${SCOPE} .a`)
  })

  it("**`@keyframes` 内部原样不动** —— `0%` 前置一层之后整段动画失效", () => {
    const out = scopePanelCss("@keyframes spin{from{opacity:0}to{opacity:1}}", PKG)
    expect(out).toBe("@keyframes spin {from{opacity:0}to{opacity:1}}")
    expect(out).not.toContain(SCOPE)
  })

  it("`@font-face` 原样保留 —— 它没有选择器可限定", () => {
    const out = scopePanelCss("@font-face{font-family:X;src:url(x.woff2)}", PKG)
    expect(out).toBe("@font-face {font-family:X;src:url(x.woff2)}")
  })

  it("无块的 at-rule 原样保留", () => {
    expect(scopePanelCss('@charset "utf-8";.a{color:red}', PKG)).toContain('@charset "utf-8";')
  })

  it("`content` 里的花括号不让样式表裂开", () => {
    const out = scopePanelCss('.a{content:"}"}', PKG)
    expect(out).toBe(`${SCOPE} .a {content:"}"}`)
  })

  it("注释先去掉，故注释里的选择器不会被限定成一条规则", () => {
    expect(scopePanelCss("/* .a{color:red} */.b{color:blue}", PKG)).toBe(`${SCOPE} .b {color:blue}`)
  })

  it("空样式表给空串，不抛错", () => {
    expect(scopePanelCss("", PKG)).toBe("")
    expect(scopePanelCss("   \n  ", PKG)).toBe("")
  })

  it("没有收尾的花括号不丢掉那条规则 —— 作者少打一个 } 时仍限定它", () => {
    expect(scopePanelCss(".a{color:red", PKG)).toBe(`${SCOPE} .a {color:red}`)
  })
})
