import { describe, expect, it } from "vitest"
import { countUnder, isGroup, nodesOf, sectionNodes, type FormNode, type GroupNode } from "./subform.js"
import type { SchemaDescriptor } from "./types.js"

/**
 * 造一个字段描述
 * @param patch 要盖上的字段
 * @returns 描述
 */
function field(patch: Partial<SchemaDescriptor> = {}): SchemaDescriptor {
  return { type: "string", ...patch }
}

/**
 * 造一个对象描述
 * @param properties 子字段表
 * @param patch 要盖上的字段
 * @returns 描述
 */
function object(properties: Record<string, SchemaDescriptor>, patch: Partial<SchemaDescriptor> = {}): SchemaDescriptor {
  return { type: "object", properties, ...patch }
}

/**
 * 取一个节点的分组形态，不是分组就让用例失败
 * @param node 节点
 * @returns 分组节点
 */
function asGroup(node: FormNode | undefined): GroupNode {
  expect(node?.kind).toBe("group")
  return node as GroupNode
}

describe("isGroup", () => {
  it("有子字段的对象是分组", () => {
    expect(isGroup(object({ a: field() }))).toBe(true)
  })

  it("没有 properties 的对象不是分组", () => {
    expect(isGroup({ type: "object" })).toBe(false)
  })

  it("properties 为空的对象不是分组 —— 摊开会是一块空标题", () => {
    expect(isGroup(object({}))).toBe(false)
  })

  it("标量不是分组", () => {
    expect(isGroup(field())).toBe(false)
  })

  it("字典不是分组：它由 keyValue 控件承载，不是一组字段", () => {
    expect(isGroup({ type: "record", values: field() })).toBe(false)
  })
})

describe("nodesOf", () => {
  it("标量成叶子，路径由 base 拼出", () => {
    const nodes = nodesOf(object({ port: field({ type: "number" }) }), "server", { port: 3000 })

    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: "field", path: "server.port", value: 3000 })
  })

  it("顶层 base 为空串时路径不带前导点", () => {
    const nodes = nodesOf(object({ name: field() }), "", { name: "x" })

    expect(nodes[0]?.path).toBe("name")
  })

  it("子对象成分组并递归", () => {
    const schema = object({ push: object({ enabled: field({ type: "boolean" }) }, { title: "推送" }) })
    const group = asGroup(nodesOf(schema, "plugin", { push: { enabled: true } })[0])

    expect(group.title).toBe("推送")
    expect(group.path).toBe("plugin.push")
    expect(group.children).toHaveLength(1)
    expect(group.children[0]).toMatchObject({ path: "plugin.push.enabled", value: true })
  })

  it("三层嵌套逐层成组", () => {
    const schema = object({ a: object({ b: object({ c: field() }) }) })
    const outer = asGroup(nodesOf(schema, "", { a: { b: { c: "v" } } })[0])
    const inner = asGroup(outer.children[0])

    expect(inner.path).toBe("a.b")
    expect(inner.children[0]).toMatchObject({ path: "a.b.c", value: "v" })
  })

  it("没写 title 的分组退回字段名", () => {
    const group = asGroup(nodesOf(object({ retry: object({ times: field() }) }), "", {})[0])

    expect(group.title).toBe("retry")
  })

  it("带上组说明", () => {
    const schema = object({ push: object({ a: field() }, { title: "推送", description: "说明文案" }) })
    const group = asGroup(nodesOf(schema, "", {})[0])

    expect(group.description).toBe("说明文案")
  })

  it("没写说明时不留 description 键", () => {
    const group = asGroup(nodesOf(object({ push: object({ a: field() }) }), "", {})[0])

    expect(Object.hasOwn(group, "description")).toBe(false)
  })

  it("配置里缺了整节时，组内字段照常出现", () => {
    // 配置文件里一行 `render:` 都没写 —— 组仍要摊开，各字段按自己的默认值渲染
    const group = asGroup(nodesOf(object({ render: object({ scale: field({ type: "number" }) }) }), "", {})[0])

    expect(group.children).toHaveLength(1)
    expect(group.children[0]).toMatchObject({ path: "render.scale", value: undefined })
  })

  it("该键上是数组而非对象时同样不塌", () => {
    const group = asGroup(nodesOf(object({ render: object({ scale: field() }) }), "", { render: [1, 2] })[0])

    expect(group.children).toHaveLength(1)
  })

  it("siblings 是本组的值，供 showWhen 判同级字段", () => {
    const schema = object({ net: object({ mode: field(), url: field() }) })
    const group = asGroup(nodesOf(schema, "", { net: { mode: "ws", url: "u" } })[0])

    expect(group.children[0]).toMatchObject({ siblings: { mode: "ws", url: "u" } })
  })

  it("次序取声明顺序，不按 order 重排", () => {
    const schema = object({ b: field({ order: 1 }), a: field({ order: 99 }) })

    expect(nodesOf(schema, "", {}).map(node => node.path)).toEqual(["b", "a"])
  })

  it("空 properties 的对象成叶子而非空组", () => {
    const nodes = nodesOf(object({ blob: object({}) }), "", {})

    expect(nodes[0]?.kind).toBe("field")
  })
})

describe("sectionNodes", () => {
  it("顶层对象摊平，其标题已在分区页签上", () => {
    const schema = object({ server: object({ port: field({ type: "number" }) }, { title: "服务器" }) })
    const nodes = sectionNodes(schema, ["server"], { server: { port: 3000 } })

    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: "field", path: "server.port" })
  })

  it("顶层对象的子对象仍成组", () => {
    const schema = object({ plugin: object({ push: object({ on: field({ type: "boolean" }) }, { title: "推送" }) }) })
    const group = asGroup(sectionNodes(schema, ["plugin"], {})[0])

    expect(group.path).toBe("plugin.push")
  })

  it("顶层标量直接成行", () => {
    const nodes = sectionNodes(object({ mode: field() }), ["mode"], { mode: "ws" })

    expect(nodes[0]).toMatchObject({ kind: "field", path: "mode", value: "ws" })
  })

  it("顶层标量的 siblings 是整份配置", () => {
    const nodes = sectionNodes(object({ mode: field(), url: field() }), ["mode"], { mode: "ws", url: "u" })

    expect(nodes[0]).toMatchObject({ siblings: { mode: "ws", url: "u" } })
  })

  it("只取本分区的那几个键", () => {
    const schema = object({ a: field(), b: field(), c: field() })

    expect(sectionNodes(schema, ["a", "c"], {}).map(node => node.path)).toEqual(["a", "c"])
  })

  it("键在 schema 里不存在时跳过，不造出空节点", () => {
    expect(sectionNodes(object({ a: field() }), ["nope"], {})).toEqual([])
  })

  it("次序取 keys 给的顺序", () => {
    const schema = object({ a: field(), b: field() })

    expect(sectionNodes(schema, ["b", "a"], {}).map(node => node.path)).toEqual(["b", "a"])
  })
})

describe("countUnder", () => {
  it("数前缀之下的路径", () => {
    expect(countUnder(["render.scale", "render.quality", "server.port"], "render")).toBe(2)
  })

  it("路径自身也算：一块分组对应的键本身被改过", () => {
    expect(countUnder(["render"], "render")).toBe(1)
  })

  it("按段比对，同前缀的兄弟字段不互相计入", () => {
    // `render.a` 不该命中 `render.ab`，否则两个字段各把对方的改动算进自己
    expect(countUnder(["render.ab", "render.abc"], "render.a")).toBe(0)
  })

  it("深层路径一并计入", () => {
    expect(countUnder(["a.b.c.d"], "a.b")).toBe(1)
  })

  it("一条都没有时为 0", () => {
    expect(countUnder([], "render")).toBe(0)
  })
})
