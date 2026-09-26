/**
 * 模块职责：把一份 SchemaDescriptor 的字段表摊成「叶子字段 / 子表单分组 / 对象数组」三种节点
 * 依赖方向：仅依赖类型
 * 生命周期：纯函数
 * 注意事项：此前嵌套对象被递归摊平成一串平行的字段行，层级只靠左侧一道竖线加缩进表达
 *          （`--indent`）—— 一组字段读起来与它上下的字段同级，那道线要对照着数才认得出。
 *          改为让嵌套对象自成一块带标题的分组，层级由**盒子**表达。
 *
 *          **对象数组自成第三种节点**（`ListNode`）：`array(object(...))` 那种「一组同构的对象」，
 *          由 `ObjectList` 渲染成一叠可增删的元素卡片，每张卡片里又是一套字段。此前面板没有这种
 *          控件，数组一律走药丸输入框，元素是对象时就渲染成一片 `[object Object]`，故那类字段只能
 *          退成「一行一项」的字符串由插件自己解析 —— 现在可以直接编辑对象了。
 *
 *          **顶层对象仍然摊平**：它的标题已经写在分区页签上，再套一层分组就是同一个名字
 *          出现两遍。故 `sectionNodes` 与 `nodesOf` 分开，前者只用于顶层。
 *
 *          节点顺序一律取声明顺序，不按 `order` 重排：`order` 是分区之间的次序（见
 *          SchemaForm 的 `sections`），组内字段的次序就是声明者写下的那个。
 */
import type { SchemaDescriptor } from "./types.js"

/** 一个叶子字段 */
export interface LeafNode {
  /** 节点类别 */
  kind: "field"
  /** 点号路径，与 `issues[].path` 一致 */
  path: string
  /** 字段描述 */
  schema: SchemaDescriptor
  /** 当前值 */
  value: unknown
  /** 同级字段的当前值，供 showWhen 判断 */
  siblings: Record<string, unknown>
}

/** 一个子表单分组 */
export interface GroupNode {
  /** 节点类别 */
  kind: "group"
  /** 本组对应的点号路径 */
  path: string
  /** 组标题 */
  title: string
  /** 组说明 */
  description?: string
  /** 组内节点，可再含分组 */
  children: FormNode[]
}

/** 一个对象数组：一叠同构的对象，可增删 */
export interface ListNode {
  /** 节点类别 */
  kind: "list"
  /** 本数组的点号路径 */
  path: string
  /** 标题 */
  title: string
  /** 说明 */
  description?: string
  /** 每个元素的对象描述，供 `ObjectList` 逐元素摊字段 */
  itemSchema: SchemaDescriptor
  /** 当前各元素 */
  items: unknown[]
}

/** 表单里的一个节点 */
export type FormNode = LeafNode | GroupNode | ListNode

/**
 * 是不是一个「有子字段的对象」
 *
 * `properties` 为空的 object 不算：那样的节点摊开是一块空分组，标题之下什么都没有。
 * @param schema 字段描述
 * @returns 是否应渲染为分组
 */
export function isGroup(schema: SchemaDescriptor): boolean {
  return schema.type === "object" && schema.properties !== undefined && Object.keys(schema.properties).length > 0
}

/**
 * 是不是一个「元素为对象的数组」
 *
 * 元素是标量的数组（`array(string())`）不算：那种走药丸输入框（`tags`），一枚药丸一项，
 * 本就够用。只有元素是**有字段的对象**时才需要对象数组控件。
 * @param schema 字段描述
 * @returns 是否应渲染为对象数组
 */
export function isObjectList(schema: SchemaDescriptor): boolean {
  return schema.type === "array" && schema.items !== undefined && isGroup(schema.items)
}

/**
 * 取一个数组节点的当前值
 *
 * 读不出数组时给空数组：配置里缺了整个列表时，控件显示成「零个元素 + 一个添加按钮」，
 * 而不是崩在 `.map` 上。
 * @param value 父对象里该键上的值
 * @returns 数组值
 */
function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 取一个对象节点的当前值
 *
 * 读不出对象时给空对象而非放弃：配置文件里缺了整节（`render:` 一行都没写）时，
 * 组里各字段仍要按自己的默认值渲染出来。
 * @param value 父对象里该键上的值
 * @returns 对象值
 */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * 摊开一个对象节点的子字段
 *
 * 子对象成为分组并递归下去，其余成为叶子。
 * @param schema 对象描述，其 `properties` 即要摊开的字段表
 * @param base 本对象的点号路径；顶层传空串
 * @param value 本对象的当前值
 * @returns 节点清单
 */
export function nodesOf(schema: SchemaDescriptor, base: string, value: Record<string, unknown>): FormNode[] {
  const out: FormNode[] = []
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = base === "" ? key : `${base}.${key}`
    if (isGroup(child)) {
      const inner = objectOf(value[key])
      out.push({
        kind: "group",
        path,
        // 没写 title 就退回字段名：一块没有标题的分组无从折叠，也说不出里面是什么
        title: child.title ?? key,
        ...(child.description === undefined ? {} : { description: child.description }),
        children: nodesOf(child, path, inner)
      })
      continue
    }
    if (isObjectList(child)) {
      out.push({
        kind: "list",
        path,
        title: child.title ?? key,
        ...(child.description === undefined ? {} : { description: child.description }),
        // `isObjectList` 已确认 `items` 是对象描述，这里的断言不会落空
        itemSchema: child.items as SchemaDescriptor,
        items: arrayOf(value[key])
      })
      continue
    }
    out.push({ kind: "field", path, schema: child, value: value[key], siblings: value })
  }
  return out
}

/**
 * 取一个分区内的节点
 *
 * **顶层对象摊平、标量直接成行、顶层对象数组成一块列表。** 顶层对象的标题即分区标题，
 * 故它不自成一块分组；而它的子对象照常成组（由 `nodesOf` 递归产出）。
 * @param schema 顶层描述，须为 object
 * @param keys 本分区内的顶层字段名
 * @param value 整份配置的当前值
 * @returns 节点清单
 */
export function sectionNodes(
  schema: SchemaDescriptor,
  keys: readonly string[],
  value: Record<string, unknown>
): FormNode[] {
  const properties = schema.properties ?? {}
  return keys.flatMap(key => {
    const child = properties[key]
    if (child === undefined) return []
    if (isGroup(child)) return nodesOf(child, key, objectOf(value[key]))
    if (isObjectList(child)) {
      return [
        {
          kind: "list",
          path: key,
          title: child.title ?? key,
          ...(child.description === undefined ? {} : { description: child.description }),
          itemSchema: child.items as SchemaDescriptor,
          items: arrayOf(value[key])
        } satisfies ListNode
      ]
    }
    return [{ kind: "field", path: key, schema: child, value: value[key], siblings: value } satisfies LeafNode]
  })
}

/**
 * 某个前缀之下有几条路径
 *
 * 供分组标题上的角标：「这一组里改了几处」与「这一组里有几处存不进去」。
 *
 * **按段比对，不是单纯的 `startsWith`**：前缀 `render.a` 不该命中 `render.ab`，
 * 否则相邻同前缀的两个字段会互相把对方的改动数算进自己。
 * @param paths 点号路径清单
 * @param prefix 前缀路径
 * @returns 命中条数
 */
export function countUnder(paths: readonly string[], prefix: string): number {
  return paths.filter(path => path === prefix || path.startsWith(`${prefix}.`)).length
}

/**
 * 把一个点号路径上的值写进对象，**沿途缺的中间对象一路建出来**
 *
 * 与 `configedit.ts` 的 `assignPath` 不同：那个遇到中间层不是对象就放弃（它作用于一份
 * 已按 schema 物化的完整配置）；这里作用于对象数组的一个元素，元素可能缺了整个嵌套对象
 * （配置里没写那一节），此时必须建出中间层，否则「给一个没写过的子字段填值」会写不进去。
 *
 * 就地修改传入的对象，故调用方须先克隆。
 * @param obj 目标对象，会被就地修改
 * @param path 元素内相对点号路径
 * @param value 新值
 */
export function setDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".")
  const leaf = parts.pop()
  if (leaf === undefined) return
  let node = obj
  for (const part of parts) {
    const next = node[part]
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[part] = {}
    node = node[part] as Record<string, unknown>
  }
  node[leaf] = value
}
