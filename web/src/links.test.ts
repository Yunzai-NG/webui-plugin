import { describe, expect, it } from "vitest"
import { safeHref } from "./links.js"

describe("safeHref", () => {
  it("http 与 https 原样放行", () => {
    expect(safeHref("https://github.com/Yunzai-NG/webui-plugin")).toBe("https://github.com/Yunzai-NG/webui-plugin")
    expect(safeHref("  http://127.0.0.1:3000/x ")).toBe("http://127.0.0.1:3000/x")
  })

  it("能在面板的源里执行脚本的协议一律挡掉，大小写与空白混写也一样", () => {
    expect(safeHref("javascript:alert(localStorage)")).toBeUndefined()
    expect(safeHref(" JaVaScRiPt:alert(1)")).toBeUndefined()
    expect(safeHref("java\tscript:alert(1)")).toBeUndefined()
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined()
    expect(safeHref("vbscript:msgbox(1)")).toBeUndefined()
  })

  it("相对地址、非字符串与空串都不算链接", () => {
    expect(safeHref("/api/state")).toBeUndefined()
    expect(safeHref("github.com/x")).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
    expect(safeHref(42)).toBeUndefined()
    expect(safeHref("")).toBeUndefined()
  })
})
