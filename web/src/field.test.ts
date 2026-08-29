/**
 * 模块职责：`field.ts` 的用例 —— 长度计数、取值范围措辞、正则说明
 * 依赖方向：测试文件，只依赖被测模块与类型
 * 生命周期：纯函数，无夹具
 * 注意事项：正则说明这一族的关键是**认不出时必须返回 undefined**。若某天有人往
 *          `PATTERN_RULES` 里加了一条过于宽松的形态，最先失效的不是被识别的那几种，
 *          而是「不该被识别的也给出了说明」——故此处对反例的断言比对正例的更多。
 */
import { describe, expect, it } from "vitest"
import { describePattern, lengthLimitOf, rangeTextOf } from "./field.js"
import type { SchemaDescriptor } from "./types.js"

describe("长度计数", () => {
  it("字符串按字数，且按码点计（与内核一致）", () => {
    const schema: SchemaDescriptor = { type: "string", max: 20 }
    expect(lengthLimitOf(schema, "一二三")).toEqual({ used: 3, max: 20, over: false, unit: "字" })
    // 一个表情符号在 UTF-16 里占两个单元，内核按码点算 1 个
    expect(lengthLimitOf(schema, "🙂")?.used).toBe(1)
  })

  it("数组按项数", () => {
    expect(lengthLimitOf({ type: "array", max: 3 }, ["a", "b"])).toEqual({ used: 2, max: 3, over: false, unit: "项" })
  })

  it("超出上限时标记 over", () => {
    expect(lengthLimitOf({ type: "string", max: 2 }, "abc")?.over).toBe(true)
    expect(lengthLimitOf({ type: "array", max: 1 }, ["a", "b"])?.over).toBe(true)
  })

  it("值缺失按 0 计，不按 undefined", () => {
    expect(lengthLimitOf({ type: "string", max: 5 }, undefined)?.used).toBe(0)
    expect(lengthLimitOf({ type: "array", max: 5 }, undefined)?.used).toBe(0)
  })

  it("**数值字段不给计数** —— 那里的 max 是取值上界，不是长度", () => {
    expect(lengthLimitOf({ type: "number", max: 65535 }, 8080)).toBeUndefined()
  })

  it("未声明 max 时没有计数", () => {
    expect(lengthLimitOf({ type: "string" }, "abc")).toBeUndefined()
  })
})

describe("取值范围措辞", () => {
  it("措辞随类型而变", () => {
    expect(rangeTextOf({ type: "number", min: 1, max: 65535 })).toBe("取值 1 ~ 65535")
    expect(rangeTextOf({ type: "string", min: 1, max: 20 })).toBe("长度 1 ~ 20")
    expect(rangeTextOf({ type: "array", min: 1, max: 4 })).toBe("项数 1 ~ 4")
  })

  it("只有一侧时用不等号", () => {
    expect(rangeTextOf({ type: "number", min: 1 })).toBe("取值 ≥ 1")
    expect(rangeTextOf({ type: "number", max: 5 })).toBe("取值 ≤ 5")
  })

  it("两侧都没有时不给说明", () => {
    expect(rangeTextOf({ type: "number" })).toBeUndefined()
  })

  it("0 是有效边界，不可当作未声明", () => {
    expect(rangeTextOf({ type: "number", min: 0, max: 0 })).toBe("取值 0 ~ 0")
  })
})

describe("正则说明", () => {
  it("认得出的几种", () => {
    expect(describePattern("^\\d+$")).toBe("只能是数字")
    expect(describePattern("^\\d{6}$")).toBe("只能是数字，须为 6 位")
    expect(describePattern("^\\d{5,}$")).toBe("只能是数字，至少 5 位")
    // 内核 s.uid() 用的就是这一条
    expect(describePattern("^\\d{1,20}$")).toBe("只能是数字，1 至 20 位")
    expect(describePattern("^[a-zA-Z0-9_-]+$")).toBe("只能是字母、数字、下划线与连字符")
    expect(describePattern("^https?:\\/\\/")).toBe("须以 http:// 或 https:// 开头")
    expect(describePattern("^ws s?://")).toBeUndefined()
  })

  it("**缺锚点的一律认不出** —— 「含有数字」与「只能是数字」不是一回事", () => {
    expect(describePattern("\\d+")).toBeUndefined()
    expect(describePattern("^\\d+")).toBeUndefined()
    expect(describePattern("\\d+$")).toBeUndefined()
  })

  it("稍有变化就认不出，宁可不说", () => {
    expect(describePattern("^\\d{6}|^[a-f]{6}$")).toBeUndefined()
    expect(describePattern("^(?!x)\\d+$")).toBeUndefined()
    expect(describePattern("^[\\u4e00-\\u9fff]+$")).toBeUndefined()
  })

  it("空正则不说", () => {
    expect(describePattern("")).toBeUndefined()
  })
})
