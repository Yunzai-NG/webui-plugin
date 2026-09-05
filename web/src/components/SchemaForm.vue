<script setup lang="ts">
/**
 * 模块职责：将一份 SchemaDescriptor 渲染为完整表单，按 group 分区
 * 依赖方向：依赖 SchemaField 与类型
 * 生命周期：随所在视图
 * 注意事项：**表单只抛出改动过的路径，不持有整份配置** —— 父组件提交的是补丁，经
 *          `PATCH /api/config/:name` 深合并写入。改成提交整份值（PUT）会抹掉前端没渲染的字段，
 *          而插件新增了配置项、面板仍是旧产物时就会出现这种字段。
 *
 *          分区按 group 与 order 排列（内核 schema 的 `.group()` / `.order()`）：
 *          排布由声明者决定，不取 Object.keys 的顺序。
 */
import { computed, nextTick, ref, watch } from "vue"
import SchemaField from "./SchemaField.vue"
import { revealTab } from "../tabscroll.js"
import type { SchemaDescriptor, SchemaIssue } from "../types.js"

const props = defineProps<{
  /** 顶层描述，必须为 object */
  schema: SchemaDescriptor
  /** 当前值 */
  value: Record<string, unknown>
  /** 服务端返回的逐字段错误 */
  issues?: readonly SchemaIssue[]
  /** 是否只读 */
  disabled?: boolean
  /**
   * 改动过的路径，用于页签上的计数
   *
   * 由父组件给出而非本组件自记：改动的账本归保存那一方管（它要据此拼补丁），
   * 两处各记一份必然在「保存成功后清账」那一刻错开。
   */
  dirty?: readonly string[]
}>()

const emit = defineEmits<{
  /** 某条路径的值发生变化 */
  (e: "change", path: string, value: unknown): void
}>()

/** 一个分区 */
interface Section {
  /** 分区标题 */
  title: string
  /** 分区内的顶层字段名 */
  keys: string[]
  /** 排序权重 */
  order: number
}

/**
 * 无组标量的归属
 *
 * 适配器的账号 schema 多是这个样子：`mode`、`url`、`token` 平铺在顶层，一个 `group` 都没写。
 */
const LOOSE = "常规"

/**
 * 按 group 聚合顶层字段
 *
 * 三条规则，缺一不可：
 *
 * - 写了 `group` 的按它归并 —— 内核配置的八组即由此而来。
 * - 没写 `group` 的**对象**自成一区，取它的 `title`：`properties` 已经是一组字段，
 *   它的标题本就是这一组的名字。
 * - 没写 `group` 的**标量**一律并入「常规」。**这一条是必须的**：一次只渲染一个分区
 *   （见模板），而让每个标量各成一区意味着「除第一个字段外一个都看不见」——
 *   napcat 的连接地址正是这样从表单里整个消失的。
 */
const sections = computed<Section[]>(() => {
  const props0 = props.schema.properties ?? {}
  const map = new Map<string, Section>()
  for (const [key, child] of Object.entries(props0)) {
    const nested = child.type === "object" && child.properties !== undefined
    const title = child.group ?? (nested ? (child.title ?? key) : LOOSE)
    const found = map.get(title)
    if (found === undefined) map.set(title, { title, keys: [key], order: child.order ?? 1000 })
    else {
      found.keys.push(key)
      found.order = Math.min(found.order, child.order ?? 1000)
    }
  }
  return [...map.values()].sort((a, b) => a.order - b.order)
})

/**
 * 当前分区
 *
 * 记标题而非序号：`sections` 的长度会随 schema 变（换一份配置、插件加了一组配置项），
 * 而记序号时那一变就指向了另一个分区 —— 表现为「打开配置页，选中的是另一栏」。
 * 标题找不到时退回第一个（见 `active`）。
 */
const picked = ref("")

/** 页签条本身，供「把要跳去的那一栏滚进视野」用 */
const bar = ref<HTMLElement | undefined>(undefined)

/** 实际生效的分区：选中的那个不在了就退回第一个 */
const active = computed(() => {
  const found = sections.value.find(item => item.title === picked.value)
  return found ?? sections.value[0]
})

/**
 * 一个路径属于哪个分区
 *
 * 按路径首段认：分区是顶层字段的归并，而叶子路径的首段就是它所属的那个顶层字段。
 * @param path 点号路径
 * @returns 分区标题；认不出时 undefined
 */
function sectionOf(path: string): string | undefined {
  const head = path.split(".")[0] ?? path
  return sections.value.find(item => item.keys.includes(head))?.title
}

/**
 * 逐分区的改动数与错误数
 *
 * **算在这里而不是让页签各自去数**：页签上要显示的是「这一栏里有几处」，而改动与错误
 * 都是按路径记的平表。一次遍历分派到各分区，比每个页签各扫一遍整张表省事，也不会
 * 出现两处口径不一致。
 */
const badges = computed(() => {
  const out = new Map<string, { dirty: number; bad: number }>()
  /**
   * 取一个分区的计数格，没有就现建
   * @param title 分区标题
   * @returns 计数格
   */
  const cell = (title: string): { dirty: number; bad: number } => {
    const found = out.get(title)
    if (found !== undefined) return found
    const made = { dirty: 0, bad: 0 }
    out.set(title, made)
    return made
  }
  for (const path of props.dirty ?? []) {
    const title = sectionOf(path)
    if (title !== undefined) cell(title).dirty += 1
  }
  for (const issue of props.issues ?? []) {
    const title = sectionOf(issue.path)
    if (title !== undefined) cell(title).bad += 1
  }
  return out
})

/**
 * 校验失败时自动跳到第一个有错的分区
 *
 * 不跳的话，保存失败只在顶部留一条汇总，而标红的那个字段在另一栏里 —— 使用者看到的是
 * 「它说有错，可我这一栏没有红字」。跳转只在「当前分区自己没错」时发生：当前栏里也有错
 * 时，他要改的就在眼前。
 */
watch(
  () => props.issues,
  list => {
    if (list === undefined || list.length === 0) return
    const here = active.value?.title
    if (here !== undefined && (badges.value.get(here)?.bad ?? 0) > 0) return
    const first = list.map(issue => sectionOf(issue.path)).find(title => title !== undefined)
    if (first === undefined) return
    picked.value = first
    /*
     * 选中之后还要把它滚进视野
     *
     * 页签多起来时那一条是横向滚动的（八个分区在模态里就已经装不下），而要跳去的那一栏
     * 可能正在溢出区里 —— 只改选中项的话，使用者看到的是「它说跳了，可高亮的还是刚才那个」。
     * `nextTick` 之后 `.primary` 才落到新的那一枚上。
     */
    void nextTick(() => revealTab(bar.value, first))
  }
)

/** 路径 → 错误消息 */
const errorOf = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const issue of props.issues ?? []) {
    // 同一路径存在多条时仅保留第一条：在一个输入框下堆叠数条提示反而无人阅读
    if (out[issue.path] === undefined) out[issue.path] = issue.message
  }
  return out
})

/**
 * 展开一个字段：object 递归为子字段，其余原样返回
 *
 * 递归到叶子而非只展开一层：内核配置就有两层（`server.port`），插件配置可能更深。
 *
 * **`indent` 在此算出，不由字段自行推断**：顶层对象（`server`）不单独成行，它的标题即分区标题，
 * 故其直属子字段层级为 0。字段只看得见自己的路径，判不出首段是分区还是一层嵌套。
 * @param key 字段名
 * @param schema 字段描述
 * @param base 父路径
 * @param parent 父对象的当前值
 * @param depth 本字段所处的缩进层级
 * @returns 叶子字段清单
 */
function flatten(
  key: string,
  schema: SchemaDescriptor,
  base: string,
  parent: Record<string, unknown>,
  depth: number
): Array<{
  /** 点号路径 */
  path: string
  /** 字段描述 */
  schema: SchemaDescriptor
  /** 当前值 */
  value: unknown
  /** 同级值，供 showWhen 判断 */
  siblings: Record<string, unknown>
  /** 缩进层级 */
  indent: number
}> {
  const path = base === "" ? key : `${base}.${key}`
  const value = parent[key]

  if (schema.type === "object" && schema.properties !== undefined) {
    const child = (value ?? {}) as Record<string, unknown>
    const inner = base === "" ? depth : depth + 1
    return Object.entries(schema.properties).flatMap(([k, s]) => flatten(k, s, path, child, inner))
  }
  return [{ path, schema, value, siblings: parent, indent: depth }]
}

/**
 * 取得某个分区内的全部叶子字段
 * @param section 分区
 * @returns 叶子字段清单
 */
function fieldsOf(section: Section): ReturnType<typeof flatten> {
  const properties = props.schema.properties ?? {}
  return section.keys.flatMap(key => {
    const child = properties[key]
    return child === undefined ? [] : flatten(key, child, "", props.value, 0)
  })
}
</script>

<template>
  <div>
    <!--
      分区改横向页签，形制取 `.toolbar.tabs`（插件页、帮助页、面板商店已在用），不新画一种

      **一次只渲染一个分区。** 内核配置有八组、三十余项，全铺开时「保存」被推到几屏之下，
      而使用者改的往往只是其中一项。角标里两个数各有分工：改动数说「这一栏我动过几处」，
      错误数说「这一栏有几处存不进去」—— 后者取错误色，因为它挡着保存。

      只有一个分区时整排不画：一个孤零零的页签点了也没有别处可去。
    -->
    <div v-if="sections.length > 1" ref="bar" class="toolbar tabs">
      <button
        v-for="section in sections"
        :key="section.title"
        type="button"
        :class="{ primary: section.title === active?.title }"
        @click="picked = section.title"
      >
        {{ section.title }}
        <span v-if="(badges.get(section.title)?.dirty ?? 0) > 0" class="tag">
          {{ badges.get(section.title)?.dirty }}
        </span>
        <span v-if="(badges.get(section.title)?.bad ?? 0) > 0" class="tag err">
          {{ badges.get(section.title)?.bad }}
        </span>
      </button>
    </div>

    <Transition name="tab" mode="out-in">
    <section v-if="active" :key="active.title" class="card">
      <!-- 标题在页签上已经写着，故这里不再重复一遍 -->
      <SchemaField
        v-for="field in fieldsOf(active)"
        :key="field.path"
        :schema="field.schema"
        :value="field.value"
        :path="field.path"
        :siblings="field.siblings"
        :error="errorOf[field.path]"
        :disabled="disabled"
        :indent="field.indent"
        @update="(path, value) => emit('change', path, value)"
      />
    </section>
    </Transition>
  </div>
</template>
