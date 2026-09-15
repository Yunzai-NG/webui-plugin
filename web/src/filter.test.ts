/**
 * 两个市场页共用的筛选逻辑的用例
 *
 * 这几个函数被插件市场与面板商店两处调用，故这份用例同时钉住两页的筛选行为 ——
 * 从前 `tagsOf` 只属于商店，用例也只在商店那份里，于是插件市场加标签筛选时无从判断
 * 「按次数降序」这条约定还在不在。
 *
 * 版本相关那几条**刻意用解不出的版本号试**（`latest`、`main`）：索引是手工维护的，
 * 迟早有人往 `minCore` 里写一个分支名，而那时的正确行为是「不因此把它藏起来」。
 */
import { describe, expect, it } from "vitest"
import {
  FITS_GATE,
  MARKET_TABS,
  activeCount,
  authorFacets,
  compareVersion,
  emptyCriteria,
  gatesOf,
  inTab,
  initialOf,
  initialsOf,
  matchesAuthors,
  matchesGate,
  matchesInitials,
  matchesKeyword,
  matchesSources,
  matchesTags,
  parseVersion,
  sourceFacets,
  tabCounts,
  tagFacets,
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

describe("tagFacets", () => {
  it("带上条目数 —— 点之前就知道会剩多少", () => {
    const items = [itemOf({ name: "a", tags: ["监控", "系统"] }), itemOf({ name: "b", tags: ["监控"] })]
    expect(tagFacets(items)).toEqual([
      { value: "监控", count: 2 },
      { value: "系统", count: 1 }
    ])
  })

  /*
   * 这一条是 `tagsOf` 那条「重复不计两次」的同一判据，在带计数的这一路上单独钉一遍
   *
   * 两个函数共用一份计数（前者是后者的名字部分），但「计数正确」与「名字去重」是两件
   * 看得见的不同事实：计数错了表现为标签上的数字比实际多，而那个数字才是这一维新加的东西。
   */
  it("同一分类在一条里写了两次仍只算一条", () => {
    expect(tagFacets([itemOf({ tags: ["监控", "监控"] })])).toEqual([{ value: "监控", count: 1 }])
  })
})

describe("initialOf", () => {
  it("按包名取首字母并大写", () => {
    expect(initialOf("adapter-napcat")).toBe("A")
    expect(initialOf("webui")).toBe("W")
  })

  /*
   * scope 不算，这是本函数唯一容易写错的地方
   *
   * 照字面取首字符会让 `@yunzai-ng/*` 下的全部包挤在 Y 之下，而面板商店里那是绝大多数 ——
   * 一个把九成条目归到同一格的索引等于没有索引。
   */
  it("**scope 不算** —— `@yunzai-ng/hardware-plugin` 归到 H 而不是 Y", () => {
    expect(initialOf("@yunzai-ng/hardware-plugin")).toBe("H")
  })

  it("非字母开头一律归到 `#`", () => {
    expect(initialOf("2048-game")).toBe("#")
    expect(initialOf("原神插件")).toBe("#")
    expect(initialOf("")).toBe("#")
  })
})

describe("initialsOf", () => {
  it("只列出现过的字母，按字母序", () => {
    const items = [itemOf({ name: "webui" }), itemOf({ name: "adapter-qqbot" }), itemOf({ name: "mhy-game" })]
    expect(initialsOf(items)).toEqual(["A", "M", "W"])
  })

  it("`#` 排在末尾 —— 它不属于字母表里的任何位置", () => {
    const items = [itemOf({ name: "原神插件" }), itemOf({ name: "webui" }), itemOf({ name: "adapter-qqbot" })]
    expect(initialsOf(items)).toEqual(["A", "W", "#"])
  })

  it("同一字母下有多条时只列一次", () => {
    expect(initialsOf([itemOf({ name: "adapter-napcat" }), itemOf({ name: "adapter-qqbot" })])).toEqual(["A"])
  })
})

describe("authorFacets", () => {
  it("按条目数降序", () => {
    const items = [
      itemOf({ name: "a", author: "Yunzai-NG" }),
      itemOf({ name: "b", author: "Yunzai-NG" }),
      itemOf({ name: "c", author: "ccxhan" })
    ]
    expect(authorFacets(items)).toEqual([
      { value: "Yunzai-NG", count: 2 },
      { value: "ccxhan", count: 1 }
    ])
  })

  it("没写作者的条目不占一项 —— 一个空作者按钮点了也是空", () => {
    expect(authorFacets([itemOf({ author: undefined }), itemOf({ name: "b", author: "   " })])).toEqual([])
  })

  it("作者名两侧的空白不算两个人", () => {
    const items = [itemOf({ name: "a", author: "ccxhan" }), itemOf({ name: "b", author: " ccxhan " })]
    expect(authorFacets(items)).toEqual([{ value: "ccxhan", count: 2 }])
  })
})

describe("sourceFacets", () => {
  it("按条目数降序", () => {
    const items = [
      itemOf({ name: "a", source: "https://one.example/index.json" }),
      itemOf({ name: "b", source: "https://one.example/index.json" }),
      itemOf({ name: "c", source: "https://two.example/index.json" })
    ]
    expect(sourceFacets(items).map(one => one.count)).toEqual([2, 1])
  })

  it("没有来源字段时给空数组 —— 调用方据此整行不显示", () => {
    expect(sourceFacets([itemOf({ source: undefined })])).toEqual([])
  })
})

describe("parseVersion", () => {
  it("拆成三段数字", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3])
  })

  it("容得下索引里的各种写法：`v` 前缀、范围符号、位数不齐", () => {
    expect(parseVersion("v0.2.0")).toEqual([0, 2, 0])
    expect(parseVersion(">=0.2.0")).toEqual([0, 2, 0])
    expect(parseVersion("^0.2")).toEqual([0, 2, 0])
    expect(parseVersion("1")).toEqual([1, 0, 0])
  })

  /*
   * 解不出时给 undefined 而不是 [0,0,0]
   *
   * 后者会让 `latest` 排在一切版本之前，于是「筛 0.2.0 及以上」会把它筛掉 —— 而正确的
   * 处置是「这个写法我不认识，别拿它做判断」。
   */
  it("**首段不是数字时整个给 undefined**", () => {
    expect(parseVersion("latest")).toBeUndefined()
    expect(parseVersion("main")).toBeUndefined()
    expect(parseVersion("")).toBeUndefined()
    expect(parseVersion(undefined)).toBeUndefined()
  })
})

describe("compareVersion", () => {
  it("逐段比", () => {
    expect(compareVersion("0.2.0", "0.3.0")).toBeLessThan(0)
    expect(compareVersion("1.0.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareVersion("0.2.0", "0.2.0")).toBe(0)
  })

  it("位数不齐时补 0 再比 —— `0.2` 与 `0.2.0` 是同一个版本", () => {
    expect(compareVersion("0.2", "0.2.0")).toBe(0)
    expect(compareVersion("0.2", "0.2.1")).toBeLessThan(0)
  })

  it("**任一侧解不出时视作相等**，从而不会被版本门筛掉", () => {
    expect(compareVersion("latest", "0.2.0")).toBe(0)
    expect(compareVersion("0.2.0", undefined)).toBe(0)
  })
})

describe("gatesOf", () => {
  it("去重并升序 —— 这一列读起来是一根数轴", () => {
    const items = [
      itemOf({ name: "a", description: "0.4.0" }),
      itemOf({ name: "b", description: "0.1.0" }),
      itemOf({ name: "c", description: "0.2.0" }),
      itemOf({ name: "d", description: "0.2.0" })
    ]
    expect(gatesOf(items, item => item.description)).toEqual(["0.1.0", "0.2.0", "0.4.0"])
  })

  it("没声明门槛的、以及解不出的一律不进这个列表", () => {
    const items = [itemOf({ name: "a", description: "" }), itemOf({ name: "b", description: "latest" })]
    expect(gatesOf(items, item => item.description)).toEqual([])
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

describe("matchesInitials", () => {
  it("没选时一律命中", () => {
    expect(matchesInitials(itemOf({ name: "webui" }), [])).toBe(true)
  })

  it("按包名的首字母判，scope 不算", () => {
    const item = itemOf({ name: "@yunzai-ng/hardware-plugin" })
    expect(matchesInitials(item, ["H"])).toBe(true)
    expect(matchesInitials(item, ["Y"])).toBe(false)
  })

  it("多选为「或」", () => {
    expect(matchesInitials(itemOf({ name: "webui" }), ["A", "W"])).toBe(true)
  })
})

describe("matchesAuthors", () => {
  it("没选时一律命中，包括没写作者的条目", () => {
    expect(matchesAuthors(itemOf({ author: undefined }), [])).toBe(true)
  })

  it("选了作者时，没写作者的条目不命中", () => {
    expect(matchesAuthors(itemOf({ author: undefined }), ["ccxhan"])).toBe(false)
  })

  it("两侧空白不影响比对", () => {
    expect(matchesAuthors(itemOf({ author: " ccxhan " }), ["ccxhan"])).toBe(true)
  })
})

describe("matchesSources", () => {
  it("没选时一律命中", () => {
    expect(matchesSources(itemOf({ source: undefined }), [])).toBe(true)
  })

  it("选了来源时只收那几个索引的条目", () => {
    const item = itemOf({ source: "https://one.example/index.json" })
    expect(matchesSources(item, ["https://one.example/index.json"])).toBe(true)
    expect(matchesSources(item, ["https://two.example/index.json"])).toBe(false)
  })
})

describe("matchesGate", () => {
  it("空串意为不筛", () => {
    expect(matchesGate("", "0.4.0", "0.2.0")).toBe(true)
    expect(matchesGate("", undefined, undefined)).toBe(true)
  })

  describe("「当前这套装得上的」", () => {
    it("门槛不高于当前版本时通过", () => {
      expect(matchesGate(FITS_GATE, "0.2.0", "0.6.0")).toBe(true)
      expect(matchesGate(FITS_GATE, "0.6.0", "0.6.0")).toBe(true)
    })

    it("门槛高于当前版本时不通过 —— 这一项存在的理由", () => {
      expect(matchesGate(FITS_GATE, "0.9.0", "0.6.0")).toBe(false)
    })

    /*
     * 没声明门槛的算通过
     *
     * 它没提任何要求，故「装得上」这个问题对它的答案是「是」。反过来把它藏起来，
     * 会让一份大半条目都没写 `minCore` 的索引在这一项下几乎全空。
     */
    it("**没声明门槛的算通过** —— 它没提要求", () => {
      expect(matchesGate(FITS_GATE, undefined, "0.6.0")).toBe(true)
      expect(matchesGate(FITS_GATE, "  ", "0.6.0")).toBe(true)
    })

    it("当前版本读不到时整项不筛 —— 那时任何判断都是猜", () => {
      expect(matchesGate(FITS_GATE, "0.9.0", undefined)).toBe(true)
      expect(matchesGate(FITS_GATE, "0.9.0", "")).toBe(true)
    })

    it("门槛写成认不出的字符串时照样通过，不凭一个没读懂的值把它藏起来", () => {
      expect(matchesGate(FITS_GATE, "latest", "0.6.0")).toBe(true)
    })
  })

  describe("具体版本「及以上」", () => {
    it("门槛在此值及以上时通过", () => {
      expect(matchesGate("0.2.0", "0.2.0", "0.6.0")).toBe(true)
      expect(matchesGate("0.2.0", "0.4.0", "0.6.0")).toBe(true)
    })

    it("门槛低于此值时不通过", () => {
      expect(matchesGate("0.4.0", "0.1.0", "0.6.0")).toBe(false)
    })

    /*
     * 与「装得上」那一路**相反**：没声明门槛的不通过
     *
     * 这一项问的是「声明的最低版本在 0.4.0 及以上的那些」，而一条没声明门槛的条目压根
     * 没有这个属性。算它通过会让结果里混进一堆没声明的条目，那时这一项等于没筛。
     */
    it("**没声明门槛的不通过** —— 它没有「最低版本」这个属性", () => {
      expect(matchesGate("0.2.0", undefined, "0.6.0")).toBe(false)
      expect(matchesGate("0.2.0", "", "0.6.0")).toBe(false)
    })

    it("与当前版本无关 —— 这一项问的是声明值，不是装得上装不上", () => {
      expect(matchesGate("0.4.0", "0.4.0", undefined)).toBe(true)
    })
  })
})

describe("页签", () => {
  it("四个页签，「全部」在最前、「未安装」紧随其后", () => {
    expect(MARKET_TABS.map(tab => tab.id)).toEqual(["all", "notinstalled", "installed", "updatable"])
  })

  it("「全部」收下一切", () => {
    expect(inTab(itemOf(), "all")).toBe(true)
    expect(inTab(itemOf({ installed: true }), "all")).toBe(true)
  })

  it("「未安装」只收没装的", () => {
    expect(inTab(itemOf({ installed: false }), "notinstalled")).toBe(true)
    expect(inTab(itemOf({ installed: true }), "notinstalled")).toBe(false)
  })

  it("「已安装」只收装了的", () => {
    expect(inTab(itemOf({ installed: false }), "installed")).toBe(false)
    expect(inTab(itemOf({ installed: true }), "installed")).toBe(true)
  })

  it("「可更新」只收可更新的", () => {
    expect(inTab(itemOf({ installed: true, updatable: false }), "updatable")).toBe(false)
    expect(inTab(itemOf({ installed: true, updatable: true }), "updatable")).toBe(true)
  })

  it("「已安装」与「未安装」恰好把「全部」分完，没有条目两边落空或两边都算", () => {
    const items = [itemOf({ name: "a" }), itemOf({ name: "b", installed: true })]
    const counts = tabCounts(items)
    expect(counts.installed + counts.notinstalled).toBe(counts.all)
  })

  it("角标与筛选**同出一源**，故两者永不打架", () => {
    const items = [
      itemOf({ name: "a" }),
      itemOf({ name: "b", installed: true }),
      itemOf({ name: "c", installed: true, updatable: true })
    ]
    const counts = tabCounts(items)
    expect(counts).toEqual({ all: 3, notinstalled: 1, installed: 2, updatable: 1 })
    for (const tab of MARKET_TABS) {
      expect(visibleItems(items, { tab: tab.id })).toHaveLength(counts[tab.id])
    }
  })
})

describe("activeCount", () => {
  it("什么都没选时为 0", () => {
    expect(activeCount(emptyCriteria())).toBe(0)
    expect(activeCount({})).toBe(0)
  })

  it("每一维只算一道，选了几个取值都算一道", () => {
    expect(activeCount({ tags: ["监控", "系统"] })).toBe(1)
    expect(activeCount({ tags: ["监控"], initials: ["A"], authors: ["ccxhan"], sources: ["x"] })).toBe(4)
  })

  it("版本门与「仅官方」各算一道", () => {
    expect(activeCount({ gate: "0.2.0" })).toBe(1)
    expect(activeCount({ gate: FITS_GATE })).toBe(1)
    expect(activeCount({ onlyOfficial: true })).toBe(1)
  })

  /*
   * 页签与关键词**不算**
   *
   * 两者都自带可见的呈现（一排页签、一个输入框），把它们算进「筛选」按钮的角标里，
   * 会让人以为收起的面板里还藏着一项没找见的条件。
   */
  it("**页签与关键词不算** —— 它们各自看得见", () => {
    expect(activeCount({ tab: "installed", keyword: "硬件" })).toBe(0)
  })
})

describe("visibleItems", () => {
  const items = [
    itemOf({ name: "hardware", title: "硬件信息", tags: ["监控"], author: "Yunzai-NG", official: true }),
    itemOf({ name: "clockx", title: "时钟", description: "一个钟", tags: ["装饰"], installed: true }),
    itemOf({ name: "quote", title: "一言", description: "随机一句", tags: ["装饰", "娱乐"], author: "ccxhan" })
  ]

  it("**空判据即什么都不筛**", () => {
    expect(visibleItems(items)).toHaveLength(3)
    expect(visibleItems(items, {})).toHaveLength(3)
  })

  it("分类为「或」而非「且」—— 勾两个标签要的是两类的全部", () => {
    expect(visibleItems(items, { tags: ["监控", "娱乐"] }).map(item => item.name)).toEqual(["hardware", "quote"])
  })

  it("关键词命中名称、标题、说明、作者与标签", () => {
    expect(visibleItems(items, { keyword: "yunzai-ng" }).map(item => item.name)).toEqual(["hardware"])
    expect(visibleItems(items, { keyword: "一言" }).map(item => item.name)).toEqual(["quote"])
    expect(visibleItems(items, { keyword: "装饰" }).map(item => item.name)).toEqual(["clockx", "quote"])
  })

  it("按首字母筛", () => {
    expect(visibleItems(items, { initials: ["H"] }).map(item => item.name)).toEqual(["hardware"])
    expect(visibleItems(items, { initials: ["C", "Q"] }).map(item => item.name)).toEqual(["clockx", "quote"])
  })

  it("按作者筛", () => {
    expect(visibleItems(items, { authors: ["ccxhan"] }).map(item => item.name)).toEqual(["quote"])
  })

  it("按官方标记筛 —— 缺这个字段的按非官方算", () => {
    expect(visibleItems(items, { onlyOfficial: true }).map(item => item.name)).toEqual(["hardware"])
  })

  it("按版本门筛，门槛取自调用方给的取值函数", () => {
    const gated = [
      itemOf({ name: "a", description: "0.1.0" }),
      itemOf({ name: "b", description: "0.4.0" }),
      itemOf({ name: "c", description: "" })
    ]
    const ctx = { gateOf: (item: Entry) => item.description, current: "0.2.0" }
    // 「装得上」：0.4.0 那条要求太高，没声明的那条算通过
    expect(visibleItems(gated, { gate: FITS_GATE }, ctx).map(item => item.name)).toEqual(["a", "c"])
    // 具体版本「及以上」：没声明的那条不通过
    expect(visibleItems(gated, { gate: "0.4.0" }, ctx).map(item => item.name)).toEqual(["b"])
  })

  it("**版本门那一维不认字段名** —— 换一个取值函数就换一个字段", () => {
    const one = [itemOf({ name: "a", description: "0.4.0", title: "0.1.0" })]
    const ctx = { current: "0.2.0" }
    expect(visibleItems(one, { gate: FITS_GATE }, { ...ctx, gateOf: item => item.description })).toHaveLength(0)
    expect(visibleItems(one, { gate: FITS_GATE }, { ...ctx, gateOf: item => item.title })).toHaveLength(1)
  })

  it("没给取值函数时版本门那一维筛不动任何东西，其余照筛", () => {
    expect(visibleItems(items, { gate: "0.4.0", tags: ["监控"] })).toHaveLength(1)
  })

  it("按来源筛", () => {
    const sourced = [
      itemOf({ name: "a", source: "https://one.example/index.json" }),
      itemOf({ name: "b", source: "https://two.example/index.json" })
    ]
    expect(visibleItems(sourced, { sources: ["https://one.example/index.json"] }).map(one => one.name)).toEqual(["a"])
  })

  it("页签、分类、关键词三者叠加", () => {
    expect(visibleItems(items, { tab: "installed", tags: ["装饰"], keyword: "时钟" }).map(i => i.name)).toEqual([
      "clockx"
    ])
    expect(visibleItems(items, { tab: "installed", tags: ["娱乐"] })).toEqual([])
  })

  it("**跨维为「且」** —— 六维一齐上仍是交集", () => {
    const ctx = { gateOf: (item: Entry) => item.description, current: "0.9.0" }
    const full = [
      itemOf({
        name: "hardware",
        title: "硬件信息",
        description: "0.2.0",
        tags: ["监控"],
        author: "Yunzai-NG",
        official: true,
        source: "https://one.example/index.json"
      }),
      itemOf({ name: "other", tags: ["监控"], author: "Yunzai-NG", official: true, description: "0.2.0" })
    ]
    const hit = visibleItems(
      full,
      {
        tab: "notinstalled",
        keyword: "硬件",
        tags: ["监控"],
        initials: ["H"],
        authors: ["Yunzai-NG"],
        gate: FITS_GATE,
        sources: ["https://one.example/index.json"],
        onlyOfficial: true
      },
      ctx
    )
    expect(hit.map(item => item.name)).toEqual(["hardware"])
  })
})

describe("emptyCriteria", () => {
  it("给出的那份判据什么都不筛", () => {
    const items = [itemOf({ name: "a" }), itemOf({ name: "b", installed: true })]
    expect(visibleItems(items, emptyCriteria())).toHaveLength(2)
  })

  it("每次给一份新的 —— 两个页面各持一份，改一个不该动另一个", () => {
    const one = emptyCriteria()
    const two = emptyCriteria()
    one.tags = ["监控"]
    expect(two.tags).toEqual([])
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

  it("四排共用这一个函数，故它只认字符串、不在意是哪一维", () => {
    expect(toggleTag(["A"], "W")).toEqual(["A", "W"])
    expect(toggleTag(["ccxhan"], "ccxhan")).toEqual([])
  })
})
