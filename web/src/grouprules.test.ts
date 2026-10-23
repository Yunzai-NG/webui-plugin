/**
 * 模块职责：群配置编辑逻辑的用例
 * 依赖方向：测试文件，只依赖 grouprules.ts
 * 生命周期：纯函数，无夹具
 * 注意事项：`effectiveOf` 的判法须与内核 scope.ts 的 `resolveScope` 一致，这里的几条与那边的用例对应
 */
import { describe, expect, it } from "vitest"
import { blankPreset, bodyText, effectiveOf, removePreset, renamePreset, scopeOf } from "./grouprules.js"

const scope = scopeOf({
  prefix: ["小云"],
  disabled: ["抽卡"],
  presets: [{ name: "安静", prefixMode: "none", ownDisabled: true, disabled: ["复读"] }],
  rules: [
    { groups: ["1"], prefixMode: "custom", prefix: ["  阿云 ", "云"] },
    { groups: ["2", "3"], preset: "安静" },
    { account: "10000", groups: ["3"], ownDisabled: true },
    { account: "20000", prefixMode: "none" }
  ]
})

describe("scopeOf", () => {
  it("旧内核没有这一节时给空的；没名字的规则组丢掉；旧的单个字符串前缀读成一项", () => {
    expect(scopeOf(undefined)).toEqual({ prefix: [], disabled: [], presets: [], rules: [] })
    expect(scopeOf({ presets: [{ name: " " }] }).presets).toEqual([])
    expect(scopeOf({ prefix: "小云" }).prefix).toEqual(["小云"])
    expect(scopeOf({ prefix: "" }).prefix).toEqual([])
    expect(scope.rules[0]).toMatchObject({ account: "*", groups: ["1"], preset: "", prefix: ["阿云", "云"] })
  })
})

describe("effectiveOf", () => {
  it("与内核同一判法：指名账号优先、写了群号优先、规则组整套套用", () => {
    expect(effectiveOf(scope, "10000", "9")).toEqual({ prefix: ["小云"], disabled: ["抽卡"] })
    expect(effectiveOf(scope, "10000", "1")).toEqual({ prefix: ["阿云", "云"], disabled: ["抽卡"] })
    expect(effectiveOf(scope, "30000", "2")).toEqual({ prefix: [], disabled: ["复读"] })
    expect(effectiveOf(scope, "10000", "3")).toEqual({ prefix: ["小云"], disabled: [] })
    expect(effectiveOf(scope, "20000", "1").prefix).toEqual(["阿云", "云"])
    expect(effectiveOf(scope, "20000", "9").prefix).toEqual([])
  })
})

describe("规则组", () => {
  it("改名时引用它的群配置跟着改", () => {
    const next = renamePreset(scope, "安静", "免打扰")
    expect(next.presets[0]?.name).toBe("免打扰")
    expect(next.rules[1]?.preset).toBe("免打扰")
  })

  it("删掉时引用它的群配置改用它当时那几项，效果不变", () => {
    const next = removePreset(scope, "安静")
    expect(next.presets).toEqual([])
    expect(effectiveOf(next, "30000", "2")).toEqual({ prefix: [], disabled: ["复读"] })
  })

  it("新规则组叫 组1、组2，跳过用过的", () => {
    expect(blankPreset(scopeOf({})).name).toBe("组1")
    expect(blankPreset(scopeOf({ presets: [{ name: "组1" }, { name: "组3" }] })).name).toBe("组2")
  })
})

describe("bodyText", () => {
  it("把一套前缀与禁用说成一句话", () => {
    expect(bodyText(scope.rules[0]!, scope)).toBe("前缀 「阿云」「云」 · 禁用沿用全局")
    expect(bodyText(scope.presets[0]!, scope)).toBe("不要前缀 · 禁用 1 项")
  })
})
