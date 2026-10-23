/**
 * 模块职责：「全部更新」并发池与汇总的用例
 * 依赖方向：测试文件，只依赖 bulkupdate.ts
 * 生命周期：纯逻辑，无夹具
 * 注意事项：并发上限用「同时在跑的最大个数」验，不验完成顺序
 */
import { describe, expect, it } from "vitest"
import { bulkSummary, runPool } from "./bulkupdate.js"

describe("runPool", () => {
  it("同时在跑的不超过上限，结果按传入顺序", async () => {
    let active = 0
    let peak = 0
    const items = [30, 5, 20, 10, 1]
    const out = await runPool(
      items,
      2,
      async ms => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, ms))
        active--
        return { name: String(ms), ok: true, text: "" }
      },
      String
    )
    expect(peak).toBe(2)
    expect(out.map(o => o.name)).toEqual(["30", "5", "20", "10", "1"])
  })

  it("一项抛错只记它失败，其余照跑", async () => {
    const out = await runPool(
      ["a", "b"],
      3,
      async name => {
        if (name === "a") throw new Error("网络断了")
        return { name, ok: true, text: "" }
      },
      name => name
    )
    expect(out).toEqual([
      { name: "a", ok: false, text: "网络断了" },
      { name: "b", ok: true, text: "" }
    ])
  })
})

describe("bulkSummary", () => {
  it("成功、失败、跳过各说一句", () => {
    expect(
      bulkSummary(
        [
          { name: "a", ok: true, text: "" },
          { name: "b", ok: false, text: "超时" }
        ],
        ["c"]
      )
    ).toBe("已更新 1 个：a。失败 1 个：b（超时）。目录有改动而跳过 1 个：c。")
  })
})
