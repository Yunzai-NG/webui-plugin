import { describe, expect, it } from "vitest"
import { countLiteralColors, layerPanelCss } from "./panelstyle.js"

/*
 * 面板插件样式进 `@layer panel` 的那一步，与写死颜色的计数
 *
 * 层包错了不会报错：`@import` 进了块里会被浏览器整条丢掉，表现为「那份字体没加载」；
 * 少包一层则插件样式与主题的先后变成谁先注入谁输，换个主题就时好时坏。
 */
describe("layerPanelCss", () => {
  it("整份包进 @layer panel", () => {
    expect(layerPanelCss(`[data-panel="p"] .a{color:red}`)).toBe(`@layer panel {\n[data-panel="p"] .a{color:red}\n}`)
  })

  it("打头的 @charset 与 @import 留在层外", () => {
    const got = layerPanelCss(`@charset "utf-8";\n@import url(x.css);\n.a{}`)
    expect(got.indexOf("@import")).toBeLessThan(got.indexOf("@layer panel"))
    expect(got.indexOf("@charset")).toBe(0)
  })
})

describe("countLiteralColors", () => {
  it("数十六进制、rgb 与 hsl", () => {
    expect(countLiteralColors(".a{color:#333;background:rgba(0,0,0,.1);border-color:hsl(10 50% 50%)}")).toBe(3)
  })

  it("令牌与 color-mix 里的令牌不算", () => {
    expect(countLiteralColors(".a{color:var(--text);background:color-mix(in srgb,var(--accent) 20%,transparent)}")).toBe(0)
  })

  it("不像十六进制的 id 选择器不算", () => {
    // `#add`、`#bad` 这类恰好全是十六进制字母的 id 会被误数 —— 只出一句提示，不改任何东西，可以接受
    expect(countLiteralColors("#main .x{}")).toBe(0)
  })
})
