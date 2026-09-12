/**
 * 两个市场页共用的筛选逻辑的用例
 *
 * 这几个函数被插件市场与面板商店两处调用，故这份用例同时钉住两页的筛选行为 ——
 * 从前 `tagsOf` 只属于商店，用例也只在商店那份里，于是插件市场加标签筛选时无从判断
 * 「按次数降序」这条约定还在不在。
 */
import { describe, expect, it } from "vitest"
import {
  MARKET_TABS,
  inTab,
  matchesKeyword,
  matchesTags,
  tabCounts,
  tagsOf,
  toggleTag,
  visibleItems,
  type Filterable,
  type Installable
} from "./filter.js"

/** 既可筛又带安装状态的条目：两个市场的条目类型都满足这个形状 */
type Entry = Filterable & Installable

/**
 * 造一条可筛的条目
 * @param over 要盖掉的字段
 * @returns 条目
 */
function itemOf(over: Partial<Entry> = {}): Entry {
  return {
    name: "hardware",
    title: "硬件信息",
    description: "把 CPU、内存与磁盘占用摆到面板上",
    tags: ["监控"],
    installed: false,
    updatable: false,
    ...over
  }
}

describe("tagsOf", () => {
  it("按出现次数降序 —— 常见的分类排在前面", () => {
    const items = [
      itemOf({ name: "a", tags: ["监控", "系统"] }),
      itemOf({ name: "b", tags: ["监控"] }),
      itemOf({ name: "c", tags: ["监控"] })
    ]
    expect(tagsOf(items)[0]).toBe("监控")
  })

  /*
   * 同次数时按名称，**用 ASCII 名字验**
   *
   * 中文的 localeCompare 取决于 Node 带的 ICU（完整版按拼音，small-icu 退化为码位序），
   * 断言一个具体的中文次序等于把用例绑在构建选项上 —— 那种失败与本函数毫无关系。
   */
  it("同次数时按名称升序", () => {
    const items = [itemOf({ name: "a", tags: ["zeta", "alpha"] }), itemOf({ name: "b", tags: ["mid"] })]
    expect(tagsOf(items)).toEqual(["alpha", "mid", "zeta"])
  })

  it("没有标签时给空数组", () => {
    expect(tagsOf([itemOf({ tags: [] })])).toEqual([])
  })

  it("同一分类在一条里出现两次不会重复计数出两项", () => {
    expect(tagsOf([itemOf({ tags: ["监控", "监控"] })])).toEqual(["监控"])
  })
})

describe("matchesTags", () => {
  it("没选分类时一律命中 —— 空数组意为不按分类筛", () => {
    expect(matchesTags(itemOf({ tags: [] }), [])).toBe(true)
  })

  it("分类为「或」而非「且」", () => {
    const item = itemOf({ tags: ["监控"] })
    expect(matchesTags(item, ["监控", "娱乐"])).toBe(true)
    expect(matchesTags(itemOf({ tags: ["装饰"] }), ["监控", "娱乐"])).toBe(false)
  })
})

describe("matchesKeyword", () => {
  const item = itemOf({ name: "hardware", title: "硬件信息", author: "Yunzai-NG", tags: ["监控"] })

  it("空串与纯空白一律命中", () => {
    expect(matchesKeyword(item, "")).toBe(true)
    expect(matchesKeyword(item, "   ")).toBe(true)
  })

  it("名称、标题、说明、作者与分类五项都搜", () => {
    expect(matchesKeyword(item, "hardware")).toBe(true)
    expect(matchesKeyword(item, "硬件")).toBe(true)
    expect(matchesKeyword(item, "磁盘")).toBe(true)
    expect(matchesKeyword(item, "yunzai")).toBe(true)
    expect(matchesKeyword(item, "监控")).toBe(true)
  })

  it("大小写不敏感", () => {
    expect(matchesKeyword(item, "HARDWARE")).toBe(true)
  })

  it("五项都不含时不命中", () => {
    expect(matchesKeyword(item, "时钟")).toBe(false)
  })

  it("作者缺失时不因此报错", () => {
    expect(matchesKeyword(itemOf({ author: undefined }), "yunzai")).toBe(false)
  })
})

describe("toggleTag", () => {
  it("未选则加上，已选则去掉", () => {
    expect(toggleTag([], "监控")).toEqual(["监控"])
    expect(toggleTag(["监控", "装饰"], "监控")).toEqual(["装饰"])
  })

  /*
   * 返回新数组而非原地改
   *
   * 调用处是 `picked.value = toggleTag(picked.value, tag)`：原地 `push` 也能让 Vue 察觉，
   * 但纯函数才能这样立断言，且不必在意传进来的是不是响应式数组。
   */
  it("不改动传进来的数组", () => {
    const picked = ["监控"]
    expect(toggleTag(picked, "装饰")).toEqual(["监控", "装饰"])
    expect(picked).toEqual(["监控"])
  })
})

describe("页签", () => {
  it("三个页签，「全部」在最前", () => {
    expect(MARKET_TABS.map(tab => tab.id)).toEqual(["all", "installed", "updatable"])
  })

  it("「全部」收下一切", () => {
    expect(inTab(itemOf(), "all")).toBe(true)
    expect(inTab(itemOf({ installed: true }), "all")).toBe(true)
  })

  it("「已安装」只收装了的", () => {
    expect(inTab(itemOf({ installed: false }), "installed")).toBe(false)
    expect(inTab(itemOf({ installed: true }), "installed")).toBe(true)
  })

  it("「可更新」只收可更新的", () => {
    expect(inTab(itemOf({ installed: true, updatable: false }), "updatable")).toBe(false)
    expect(inTab(itemOf({ installed: true, updatable: true }), "updatable")).toBe(true)
  })

  it("角标与筛选**同出一源**，故两者永不打架", () => {
    const items = [
      itemOf({ name: "a" }),
      itemOf({ name: "b", installed: true }),
      itemOf({ name: "c", installed: true, updatable: true })
    ]
    const counts = tabCounts(items)
    expect(counts).toEqual({ all: 3, installed: 2, updatable: 1 })
    for (const tab of MARKET_TABS) {
      expect(visibleItems(items, tab.id, [], "")).toHaveLength(counts[tab.id])
    }
  })
})

describe("visibleItems", () => {
  const items = [
    itemOf({ name: "hardware", title: "硬件信息", tags: ["监控"], author: "Yunzai-NG" }),
    itemOf({ name: "clockx", title: "时钟", description: "一个钟", tags: ["装饰"], installed: true }),
    itemOf({ name: "quote", title: "一言", description: "随机一句", tags: ["装饰", "娱乐"] })
  ]

  it("分类为「或」而非「且」—— 勾两个标签要的是两类的全部", () => {
    expect(visibleItems(items, "all", ["监控", "娱乐"], "").map(item => item.name)).toEqual(["hardware", "quote"])
  })

  it("关键词命中名称、标题、说明、作者与标签", () => {
    expect(visibleItems(items, "all", [], "yunzai-ng").map(item => item.name)).toEqual(["hardware"])
    expect(visibleItems(items, "all", [], "一言").map(item => item.name)).toEqual(["quote"])
    expect(visibleItems(items, "all", [], "装饰").map(item => item.name)).toEqual(["clockx", "quote"])
  })

  it("页签、分类、关键词三者叠加", () => {
    expect(visibleItems(items, "installed", ["装饰"], "时钟").map(item => item.name)).toEqual(["clockx"])
    expect(visibleItems(items, "installed", ["娱乐"], "").map(item => item.name)).toEqual([])
  })
})
