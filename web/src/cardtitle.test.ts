/**
 * 模块职责：展示用格式化的用例
 * 依赖方向：测试文件，只依赖 cardtitle.ts
 * 生命周期：纯函数，无夹具
 * 注意事项：只钉卡片标题
 */
import { describe, expect, it } from "vitest"
import { cardTitle } from "./cardtitle.js"

describe("cardTitle", () => {
  it("去掉中英文括号与其中内容", () => {
    expect(cardTitle("OneBot v11 适配器（NapCat / LLOneBot / SnowLuma）")).toBe("OneBot v11 适配器")
    expect(cardTitle("渲染器 (puppeteer) 版")).toBe("渲染器 版")
  })

  it("没有括号原样；整个名字都在括号里时也原样", () => {
    expect(cardTitle("webui")).toBe("webui")
    expect(cardTitle("（测试）")).toBe("（测试）")
  })
})
