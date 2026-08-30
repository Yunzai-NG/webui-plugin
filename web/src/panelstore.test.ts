/**
 * 商店的浏览器侧纯函数用例
 *
 * 重点是 `storeResultText` 的第三段（「下一步该做什么」）：那一段有三种答案，而说错任一种
 * 都会让使用者做错事 —— 把「须重载 webui」说成「刷新页面」，他会刷新、看不到东西、
 * 然后以为装坏了。其余是筛选与角标的一致性。
 */
import { describe, expect, it } from "vitest"
import {
  STORE_TABS,
  inTab,
  setupNotes,
  storeResultText,
  storeUrlOf,
  tabCounts,
  tagsOf,
  versionText,
  visibleItems,
  willRunPm
} from "./panelstore.js"
import type { PanelStoreItem, PanelStoreResult } from "./types.js"

/**
 * 造一条商店条目
 * @param over 要盖掉的字段
 * @returns 条目
 */
function itemOf(over: Partial<PanelStoreItem> = {}): PanelStoreItem {
  return {
    name: "hardware",
    title: "硬件信息",
    description: "十枚组件",
    tags: ["监控"],
    official: true,
    source: "https://example/webui_index.json",
    installed: false,
    updatable: false,
    ...over
  }
}

/**
 * 造一次安装结果
 * @param over 要盖掉的字段
 * @returns 结果
 */
function resultOf(over: Partial<PanelStoreResult> = {}): PanelStoreResult {
  return {
    name: "hardware",
    dir: "/opt/plugins/webui/plugins/hardware",
    via: "git",
    version: "0.4.0",
    needsDependencies: false,
    updatable: "pull",
    hasServer: false,
    ...over
  }
}

describe("storeUrlOf", () => {
  it("列表端点不带尾斜杠", () => {
    expect(storeUrlOf()).toBe("/plugin/webui/panelstore")
  })

  it("子路径拼在后面", () => {
    expect(storeUrlOf("refresh")).toBe("/plugin/webui/panelstore/refresh")
    expect(storeUrlOf("hardware/update")).toBe("/plugin/webui/panelstore/hardware/update")
  })

  it("**不在 `/api` 之下** —— 商店是 webui 自己开的，内核对它一无所知", () => {
    expect(storeUrlOf()).not.toContain("/api/")
  })
})

describe("页签", () => {
  it("三个页签，「全部」在最前", () => {
    expect(STORE_TABS.map(tab => tab.id)).toEqual(["all", "installed", "updatable"])
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
    for (const tab of STORE_TABS) {
      expect(visibleItems(items, tab.id, [], "")).toHaveLength(counts[tab.id])
    }
  })
})

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
})

describe("visibleItems", () => {
  const items = [
    itemOf({ name: "hardware", title: "硬件信息", tags: ["监控"], author: "Yunzai-NG" }),
    itemOf({ name: "clockx", title: "时钟", tags: ["装饰"], installed: true }),
    itemOf({ name: "quote", title: "一言", tags: ["装饰", "娱乐"] })
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

describe("versionText", () => {
  it("未装时给索引里那个", () => {
    expect(versionText(itemOf({ version: "0.4.0" }))).toBe("0.4.0")
  })

  it("索引没写版本时说「未声明」，不留空", () => {
    expect(versionText(itemOf())).toBe("未声明")
  })

  it("已装且一致时只给一个数", () => {
    expect(versionText(itemOf({ version: "0.4.0", installed: true, installedVersion: "0.4.0" }))).toBe("0.4.0")
  })

  it("可更新时给「旧 → 新」", () => {
    expect(
      versionText(itemOf({ version: "0.4.0", installed: true, installedVersion: "0.3.0", updatable: true }))
    ).toBe("0.3.0 → 0.4.0")
  })

  it("已装但读不到版本时说「未知」", () => {
    expect(versionText(itemOf({ version: "0.4.0", installed: true }))).toBe("未知")
  })
})

describe("storeResultText", () => {
  it("只有浏览器侧的包：**刷新页面即可**", () => {
    const text = storeResultText(resultOf())
    expect(text).toContain("0.4.0 已装到")
    expect(text).toContain("刷新页面即可看到它的组件")
    expect(text).not.toContain("重载")
  })

  it("**带 node 侧的包须重载 webui，且明说「只刷新页面不够」**", () => {
    const text = storeResultText(resultOf({ hasServer: true }))
    expect(text).toContain("须到插件页重载 webui")
    expect(text).toContain("只刷新页面不够")
  })

  it("带 node 侧且缺依赖时，顺序是**先装依赖再重载** —— 反过来重载会 import 失败", () => {
    const text = storeResultText(resultOf({ hasServer: true, needsDependencies: true }))
    expect(text).toContain("pnpm install")
    expect(text).toContain("装完依赖后，到插件页重载 webui")
  })

  it("依赖跑成了就说是哪个包管理器装的", () => {
    const text = storeResultText(resultOf({ installedDeps: true, packageManager: "pnpm", hasServer: true }))
    expect(text).toContain("依赖已由 pnpm 装好")
    expect(text).toContain("须到插件页重载 webui")
  })

  it("依赖跑失败时把原因带上，并给出自行执行的办法", () => {
    const text = storeResultText(resultOf({ needsDependencies: true, dependencyError: "网络不可达" }))
    expect(text).toContain("依赖没装上（网络不可达）")
    expect(text).toContain("自行执行 pnpm install")
  })

  it("没声明依赖的包**不提依赖** —— 那是多数面板插件的常态", () => {
    expect(storeResultText(resultOf())).not.toContain("依赖")
  })

  it("**就地拉到新提交说「已就地更新」，且点明依赖没被动过**", () => {
    const text = storeResultText(resultOf({ via: "pull", changed: true, fromVersion: "0.3.0", hasServer: true }))
    expect(text).toContain("已就地更新：0.3.0 → 0.4.0")
    expect(text).toContain("已装好的依赖未被动过")
  })

  it("**已是最新不能说成「已更新」** —— 后者会让人去找一个并不存在的变化", () => {
    const text = storeResultText(resultOf({ via: "pull", changed: false }))
    expect(text).toContain("已是最新版本 0.4.0")
    expect(text).toContain("远端没有新提交")
    expect(text).not.toContain("已就地更新")
  })

  it("已是最新时不再说「下一步做什么」—— 什么都没变，无事可做", () => {
    const text = storeResultText(resultOf({ via: "pull", changed: false, hasServer: true }))
    expect(text).not.toContain("重载")
    expect(text).not.toContain("刷新页面")
  })

  it("拉取后版本号未变时只给一个数，不写「0.4.0 → 0.4.0」", () => {
    const text = storeResultText(resultOf({ via: "pull", changed: true, fromVersion: "0.4.0" }))
    expect(text).toContain("已就地更新：0.4.0。")
    expect(text).not.toContain("→")
  })
  it("**归档来源要说明「此后更新会整目录重下」** —— 那笔代价在装完这一刻是隐形的", () => {
    const archive = storeResultText(resultOf({ via: "tarball", updatable: "reinstall" }))
    expect(archive).toContain("整目录重下")

    // git 那条路是常态，不必出声 —— 每次都提一句反而会把真正要注意的那句淹掉
    const git = storeResultText(resultOf({ via: "git", updatable: "pull" }))
    expect(git).not.toContain("整目录重下")
  })

  it("跑过装后步骤时说出跑了哪几个 —— 一次几分钟的等待要有交代", () => {
    const text = storeResultText(
      resultOf({ installedDeps: true, packageManager: "pnpm", ranScripts: ["build", "install:browser"] })
    )
    expect(text).toContain("build、install:browser")
  })

  it("**装后步骤失败时不说「刷新即可看到组件」** —— 没编译出产物，看不到", () => {
    const text = storeResultText(resultOf({ installedDeps: true, ranScripts: [], setupError: "build：TS2304" }))
    expect(text).toContain("TS2304")
    expect(text).not.toContain("刷新页面即可")
    expect(text).toContain("自行处理")
    /*
     * **后手不能指向装依赖** —— 两种失败的下一步动作不同
     *
     * 依赖那一步是成功的（`installedDeps` 为真），此时叫人去 `pnpm install` 会让他
     * 跑一遍幂等的命令、看到「已是最新」，然后不知道该怎么办。真正要跑的是那个 script。
     */
    expect(text).not.toContain("pnpm install")
  })

  it("装后步骤失败且带 node 侧时，不叫人去重载 —— 那会白跑一趟", () => {
    const text = storeResultText(resultOf({ hasServer: true, installedDeps: true, setupError: "build：挂了" }))
    expect(text).not.toContain("重载 webui 才会生效")
  })
})

describe("willRunPm", () => {
  it("声明了依赖就要跑", () => {
    expect(willRunPm(itemOf({ deps: true }))).toBe(true)
  })

  it("**只声明了装后步骤、没声明依赖时也要跑** —— 产物那一层多半没进仓库", () => {
    expect(willRunPm(itemOf({ setup: { scripts: ["build"], dev: true } }))).toBe(true)
  })

  it("两项都没声明就不跑 —— 多数只有浏览器侧的包属于此类", () => {
    expect(willRunPm(itemOf())).toBe(false)
  })

  it("scripts 为空数组等同于没声明", () => {
    expect(willRunPm(itemOf({ setup: { scripts: [], dev: true } }))).toBe(false)
  })
})

describe("setupNotes", () => {
  it("什么都不跑的包给空数组 —— 一句「会自动装依赖」会让人以为它也许需要", () => {
    expect(setupNotes(itemOf())).toEqual([])
  })

  it("只声明依赖时说装依赖，不提编译", () => {
    const notes = setupNotes(itemOf({ deps: true })).join("\n")
    expect(notes).toContain("pnpm install")
    expect(notes).not.toContain("依次执行")
  })

  it("**有装后步骤时逐个列出名字** —— 事先不说会让人以为界面卡住了", () => {
    const notes = setupNotes(itemOf({ deps: true, setup: { scripts: ["build", "install:browser"], dev: true } })).join("\n")
    expect(notes).toContain("build、install:browser")
    expect(notes).toContain("耗时可达数分钟")
    // 知情同意的「知情」那一半，且要点明它不是一道新的边界
    expect(notes).toContain("import()")
  })
})