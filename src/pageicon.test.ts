import { describe, expect, it } from "vitest"
import { parseIcon } from "./pageicon.js"

/**
 * `parseIcon` 的用例
 *
 * 分两半：**能画出来的要收下**（否则插件传了图标却总是回落到默认，作者无从判断自己写错了
 * 什么），**取数据与执行脚本的路子要一条不漏**（这是把插件给的 markup 内联进面板 DOM
 * 的前提 —— 白名单漏一格，装一个插件就等于给面板开一条 XSS）。
 */
describe("parseIcon", () => {
  describe("收下能画的", () => {
    it("裸 path 数据当作一个 path 元素", () => {
      expect(parseIcon("M4 12h16")).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })

    it("整段 svg 里的 path 抠出来，svg 自身的属性一概不留", () => {
      const raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#333"><path d="M4 12h16"/></svg>`
      expect(parseIcon(raw)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })

    it("多个形状元素按出现顺序收下", () => {
      const raw = `<svg><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg>`
      expect(parseIcon(raw)).toEqual([
        { tag: "circle", attrs: { cx: "12", cy: "12", r: "8" } },
        { tag: "path", attrs: { d: "M8 12h8" } }
      ])
    })

    it("七种形状元素都认", () => {
      const raw = `<svg>
        <path d="M1 1h2"/><circle cx="1" cy="1" r="1"/><ellipse cx="1" cy="1" rx="2" ry="1"/>
        <rect x="1" y="1" width="2" height="2"/><line x1="1" y1="1" x2="2" y2="2"/>
        <polyline points="1,1 2,2"/><polygon points="1,1 2,2 3,1"/>
      </svg>`
      expect(parseIcon(raw)?.map(s => s.tag)).toEqual([
        "path",
        "circle",
        "ellipse",
        "rect",
        "line",
        "polyline",
        "polygon"
      ])
    })

    it("容器元素跳过而不作废", () => {
      const raw = `<svg><defs></defs><title>图标</title><desc>说明</desc><g><path d="M4 12h16"/></g></svg>`
      expect(parseIcon(raw)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })

    it("单引号属性、自闭合与否都收", () => {
      expect(parseIcon(`<path d='M4 12h16'></path>`)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })

    it("小数、负数与指数记号是合法几何", () => {
      const d = "M-0.5 1.25e1h16"
      expect(parseIcon(d)).toEqual([{ tag: "path", attrs: { d } }])
    })

    it("前后空白与 XML 声明不影响解析", () => {
      const raw = `  <?xml version="1.0"?>\n<svg><path d="M4 12h16"/></svg>  `
      expect(parseIcon(raw)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })
  })

  describe("上色属性一律丢掉，图标才跟得上主题", () => {
    it("fill / stroke / stroke-width 不进结果", () => {
      const raw = `<path d="M4 12h16" fill="#333" stroke="red" stroke-width="4"/>`
      expect(parseIcon(raw)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })

    it("style 不进结果", () => {
      const raw = `<path d="M4 12h16" style="fill:url(#x);stroke:red"/>`
      expect(parseIcon(raw)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })

    it("class 与 id 不进结果：它们能蹭上面板自己的样式", () => {
      const raw = `<path d="M4 12h16" class="nav-icon" id="logo"/>`
      expect(parseIcon(raw)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })

    it("transform 不进结果：它能把图形挪出视框", () => {
      const raw = `<path d="M4 12h16" transform="translate(9999,9999)"/>`
      expect(parseIcon(raw)).toEqual([{ tag: "path", attrs: { d: "M4 12h16" } }])
    })
  })

  describe("取数据与执行脚本的路子", () => {
    it("script 元素让整枚图标作废", () => {
      expect(parseIcon(`<svg><script>fetch("//evil")</script><path d="M4 12h16"/></svg>`)).toBeUndefined()
    })

    it("use 不认：它能引用外部文档", () => {
      expect(parseIcon(`<svg><use href="//evil/x#y"/></svg>`)).toBeUndefined()
    })

    it("image 不认：它会向外发一次请求", () => {
      expect(parseIcon(`<svg><image href="//evil/pixel.png"/></svg>`)).toBeUndefined()
    })

    it("foreignObject 不认：里面是 HTML", () => {
      expect(parseIcon(`<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>`)).toBeUndefined()
    })

    it("style 元素不认：它能改面板别处的样式", () => {
      expect(parseIcon(`<svg><style>.nav-icon{display:none}</style><path d="M4 12h16"/></svg>`)).toBeUndefined()
    })

    it("animate 不认", () => {
      expect(parseIcon(`<svg><path d="M4 12h16"/><animate attributeName="d" to="M0 0"/></svg>`)).toBeUndefined()
    })

    it("onload 挂在白名单元素上也进不来", () => {
      expect(parseIcon(`<path d="M4 12h16" onload="alert(1)"/>`)).toEqual([
        { tag: "path", attrs: { d: "M4 12h16" } }
      ])
    })

    it("几何属性里带引号或括号即作废", () => {
      expect(parseIcon(`<path d="M4 12h16&quot; onload=&quot;alert(1)"/>`)).toBeUndefined()
      expect(parseIcon(`<circle cx="url(#x)" cy="1" r="1"/>`)).toBeUndefined()
    })

    it("裸 path 数据里带括号即作废", () => {
      expect(parseIcon(`M4 12h16" onload="alert(1)`)).toBeUndefined()
      expect(parseIcon("javascript:alert(1)")).toBeUndefined()
    })
  })

  describe("认不出就当没给", () => {
    it("非字符串", () => {
      expect(parseIcon(undefined)).toBeUndefined()
      expect(parseIcon(null)).toBeUndefined()
      expect(parseIcon(42)).toBeUndefined()
      expect(parseIcon({ d: "M4 12h16" })).toBeUndefined()
    })

    it("空串与纯空白", () => {
      expect(parseIcon("")).toBeUndefined()
      expect(parseIcon("   \n  ")).toBeUndefined()
    })

    it("没有 moveto 的 path 画不出东西，归到没给那一类", () => {
      expect(parseIcon("12")).toBeUndefined()
      expect(parseIcon("h16v8")).toBeUndefined()
      expect(parseIcon(`<path d="h16"/>`)).toBeUndefined()
    })

    it("一个形状都没有的 svg", () => {
      expect(parseIcon("<svg></svg>")).toBeUndefined()
      expect(parseIcon("<svg><g></g></svg>")).toBeUndefined()
    })

    it("形状元素只剩非几何属性时不收它，于是整枚作废", () => {
      expect(parseIcon(`<svg><rect style="width:9px" fill="red"/></svg>`)).toBeUndefined()
    })
  })

  describe("体量上限", () => {
    it("形状元素过多即作废", () => {
      const many = `<svg>${'<path d="M1 1h2"/>'.repeat(25)}</svg>`
      expect(parseIcon(many)).toBeUndefined()
    })

    it("刚好到上限仍收下", () => {
      const at = `<svg>${'<path d="M1 1h2"/>'.repeat(24)}</svg>`
      expect(parseIcon(at)).toHaveLength(24)
    })

    it("单个属性值过长即作废", () => {
      expect(parseIcon(`M1 1${"h1".repeat(4096)}`)).toBeUndefined()
    })
  })
})
