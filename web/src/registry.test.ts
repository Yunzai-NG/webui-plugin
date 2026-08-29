/**
 * 模块职责：注册表的用例 —— 按包归并、页签注册、重复标识不被覆盖
 * 依赖方向：测试文件，依赖 registry.ts（它只有 type import，故在 node 环境下可跑）
 * 生命周期：一次性
 * 注意事项：**注册表是模块级单例，且没有清空的入口**（注册在模块加载期一次完成，运行期不再变），
 *          故用例之间共享一份状态。每条用例各用一套独有的 id 与包键，断言一律按自己的键过滤，
 *          不比 `panelPackages().length` 这类全局的数 —— 否则加一条用例就会改掉另一条的结果。
 *
 *          **重点在归并那几条**：「一个包一张卡片」算错了不报错，只表现为「hardware 摊成了
 *          九张卡片」或「两个插件并成了一张」，而那要靠肉眼看图才发现。
 */
import { describe, expect, it, vi } from "vitest"
import { panelPackages, panelTabs, panelTabsOf, registerTab, registerWidget, type WidgetDef } from "./registry.js"

/** 造一枚面板插件组件 */
function widget(patch: Partial<WidgetDef> & Pick<WidgetDef, "id">): WidgetDef {
  return {
    page: "overview",
    title: patch.id,
    source: "plugin",
    layout: { w: 3, h: 3 },
    component: {},
    ...patch
  }
}

/**
 * 取某一个包的那一行
 * @param key 包键
 * @returns 该包在插件页上的一行
 */
const rowOf = (key: string) => panelPackages().find(row => row.key === key)

describe("panelPackages 的归并", () => {
  it("**同一个包的多枚组件归成一行** —— 算错了不报错，只表现为一个包摊成九张卡片", () => {
    const meta = { version: "1.0.0", description: "硬件", repository: "https://example.com/hw", author: "某人" }
    for (const id of ["t1.cpu", "t1.memory", "t1.disk"]) {
      registerWidget(widget({ id, pkg: "panels/t1", kind: "multi", meta, from: "panels/t1/index.js" }))
    }

    const row = rowOf("panels/t1")
    expect(row?.widgets.map(w => w.id)).toEqual(["t1.cpu", "t1.memory", "t1.disk"])
    // 显示名去掉归属那一段：使用者眼里这个插件叫 t1，不叫 panels/t1
    expect(row?.name).toBe("t1")
    expect(row?.kind).toBe("multi")
    expect(row?.meta).toEqual(meta)
  })

  it("**两个包不并成一行** —— 反方向同样只能靠看图发现", () => {
    registerWidget(widget({ id: "t2a.card", pkg: "panels/t2a" }))
    registerWidget(widget({ id: "t2b.card", pkg: "panels/t2b" }))

    expect(rowOf("panels/t2a")?.widgets).toHaveLength(1)
    expect(rowOf("panels/t2b")?.widgets).toHaveLength(1)
  })

  it("失败的占位格进它所属包的同一行，并另记在 failures 里", () => {
    const meta = { version: "2.0.0", description: "带一枚坏的", repository: "https://example.com/t3", author: "某人" }
    registerWidget(widget({ id: "t3.good", pkg: "panels/t3", kind: "multi", meta }))
    registerWidget(widget({ id: "panelfail.panels.t3", pkg: "panels/t3", kind: "multi", failure: "缺少 id" }))

    const row = rowOf("panels/t3")
    // 「装了却没出现」的答案要在这张卡片上，故坏的那枚与好的那枚同属一行
    expect(row?.widgets).toHaveLength(2)
    expect(row?.failures.map(w => w.failure)).toEqual(["缺少 id"])
    // meta 取组内第一个非空：占位格没有 meta，不该把整行的 meta 抹成空
    expect(row?.meta).toEqual(meta)
  })

  it("单文件各自成一行 —— 使用者眼里 clock.js 与一个包同样都是「装了的一个东西」", () => {
    registerWidget(widget({ id: "t4.clock", pkg: "panels/t4-clock.js", kind: "single" }))
    registerWidget(widget({ id: "t4.hello", pkg: "panels/t4-hello.js", kind: "single" }))

    expect(rowOf("panels/t4-clock.js")?.name).toBe("t4-clock.js")
    expect(rowOf("panels/t4-hello.js")?.widgets).toHaveLength(1)
  })

  it("没有 pkg 的各自成一行（用 id 兜底）—— 归并不到时宁可多一张卡片，不该并错", () => {
    registerWidget(widget({ id: "t5.lonely" }))
    expect(rowOf("t5.lonely")?.widgets.map(w => w.id)).toEqual(["t5.lonely"])
  })

  it("内置组件不进插件页 —— 那一页回答的是「我装了什么」", () => {
    registerWidget(widget({ id: "t6.builtin", source: "builtin", pkg: "panels/t6" }))
    expect(rowOf("panels/t6")).toBeUndefined()
  })

  it("**只出页签、一枚组件都没有的包仍有一行** —— 否则它整张卡片消失，正是本批要消灭的一类", () => {
    registerTab({ id: "t7.tab", title: "只有页签", pkg: "panels/t7", component: {} })

    const row = rowOf("panels/t7")
    expect(row?.widgets).toHaveLength(0)
    expect(row?.tabs.map(t => t.id)).toEqual(["t7.tab"])
    expect(row?.name).toBe("t7")
  })

  it("包的页签挂在它自己那一行上", () => {
    registerWidget(widget({ id: "t8.card", pkg: "panels/t8" }))
    registerTab({ id: "t8.tab", title: "页签", pkg: "panels/t8", component: {} })

    expect(rowOf("panels/t8")?.tabs.map(t => t.id)).toEqual(["t8.tab"])
    // 别人的页签不该出现在这一行
    expect(panelTabsOf("panels/t8")).toHaveLength(1)
  })
})

describe("registerTab", () => {
  it("同标识不许后注册者覆盖，规则与 registerWidget 一致", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(registerTab({ id: "t9.dup", title: "先来的", pkg: "panels/t9", component: {} })).toBe(true)
    expect(registerTab({ id: "t9.dup", title: "后来的", pkg: "panels/t9-other", component: {} })).toBe(false)
    spy.mockRestore()

    // 留下的是先注册的那一个：否则「这个页签里是什么」取决于目录里的文件名排序
    expect(panelTabs().filter(t => t.id === "t9.dup").map(t => t.title)).toEqual(["先来的"])
  })

  it("panelTabs 给的是副本，外部改不动注册表", () => {
    const before = panelTabs().length
    panelTabs().push({ id: "t10.injected", title: "外部塞的", pkg: "x", component: {} })
    expect(panelTabs()).toHaveLength(before)
  })
})
