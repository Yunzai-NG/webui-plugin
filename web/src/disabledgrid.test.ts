/**
 * 模块职责：禁用清单格子的用例
 * 依赖方向：测试文件，只依赖 disabledgrid.ts
 * 生命周期：纯函数，无夹具
 */
import { describe, expect, it } from "vitest"
import { buildTiles, detailAfter, staleOf, tilesOf, visibleCount } from "./disabledgrid.js"
import type { CommandItem } from "./types.js"

const cmd = (plugin: string, name: string, hidden = false): CommandItem =>
  ({ name, patterns: [name], plugin, master: false, admin: false, hidden, disabled: false }) as CommandItem

const commands = [cmd("mhy", "#抽卡"), cmd("mhy", "#体力"), cmd("mhy", "#内部", true), cmd("hello", "#帮助"), cmd("抽签", "#抽签"), cmd("早安", "#早安")]
const value = ["hello", "mhy:#体力", "早安:#早安", "gone:#x"]
const tiles = buildTiles(["mhy", "hello"], ["早安", "抽签"], commands, value)

describe("buildTiles", () => {
  it("目录插件在前、单文件 JS 在后，各按名字排；隐藏命令不列", () => {
    expect(tiles.map(t => t.name)).toEqual(["hello", "mhy", "抽签", "早安"])
    expect(tiles.find(t => t.name === "mhy")).toMatchObject({ script: false, cmds: ["#抽卡", "#体力"], whole: false, added: ["#体力"] })
    expect(tiles.find(t => t.name === "hello")?.whole).toBe(true)
  })
})

describe("tilesOf", () => {
  it("按页签分开；「已禁用」两类都收、只收禁了点什么的", () => {
    expect(tilesOf(tiles, "plugins", "").map(t => t.name)).toEqual(["hello", "mhy"])
    expect(tilesOf(tiles, "scripts", "").map(t => t.name)).toEqual(["抽签", "早安"])
    expect(tilesOf(tiles, "disabled", "").map(t => t.name)).toEqual(["hello", "mhy", "早安"])
  })

  it("筛选认名字，也认其中的命令", () => {
    expect(tilesOf(tiles, "plugins", "体力").map(t => t.name)).toEqual(["mhy"])
    expect(tilesOf(tiles, "scripts", " 抽 ").map(t => t.name)).toEqual(["抽签"])
  })
})

describe("staleOf", () => {
  it("清单里没有的插件，连同它的单条命令", () => {
    expect(staleOf(value, tiles)).toEqual(["gone:#x"])
  })
})

describe("visibleCount / detailAfter", () => {
  it("收起时整行整行露", () => {
    expect(visibleCount(4, 3, 30)).toBe(12)
    expect(visibleCount(4, 3, 7)).toBe(7)
    expect(visibleCount(0, 3, 30)).toBe(3)
  })

  it("详情插在所在那一行的末格之后，末行不满时插在最后一格之后", () => {
    expect(detailAfter(0, 4, 12)).toBe(3)
    expect(detailAfter(5, 4, 12)).toBe(7)
    expect(detailAfter(8, 4, 10)).toBe(9)
    expect(detailAfter(2, 1, 5)).toBe(2)
  })
})
