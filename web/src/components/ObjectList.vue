<script setup lang="ts">
/**
 * 模块职责：对象数组 —— 外面只显示「配置了几项」，点「配置」在弹窗里预览、增删、编辑
 * 依赖方向：依赖 SchemaField、SubForm、Modal、subform.ts、configedit.ts
 * 生命周期：随父表单；弹窗开合是本组件自己的状态
 * 注意事项：**外面只留一行摘要，元素卡片全收进弹窗。** 一个列表铺开会占很高 —— 站点、白名单
 *          那类动辄十几项,把下面的字段全推走。故常态只显示标题与「N 项」,点「配置」才在弹窗里
 *          展开那一叠卡片。有错时摘要上的角标转错误色,点开即见是哪一项。
 *
 *          **整个数组作为一个值一次性回传**：内核 PATCH 对数组是整体替换,没法只改 `list[1].url`。
 *          任一元素任一字段一改,就克隆整个数组、把改动写进那一份、再发**整个数组**上去。
 *
 *          **元素内字段用绝对路径**（`list[0].url`）：DOM id 不撞、错误直接对上内核回报的
 *          `list[0].url`、改动计数按前缀数。回传时才剥掉元素前缀写进那一个元素。
 *
 *          **本组件递归引用自己**：元素字段里若还有对象数组,`<ObjectList>` 在自己模板里出现。
 */
import { computed, ref } from "vue"
import Modal from "./Modal.vue"
import SchemaField from "./SchemaField.vue"
import SubForm from "./SubForm.vue"
import { countUnder, nodesOf, setDeep, type ListNode } from "../subform.js"
import { defaultsOf, snapshot } from "../configedit.js"

const props = defineProps<{
  /** 本数组节点 */
  node: ListNode
  /** 路径 → 错误消息（绝对路径，与内核回报一致） */
  errorOf: Record<string, string>
  /** 改动过的路径（绝对） */
  dirty?: readonly string[]
  /** 是否整体只读 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 整个数组的新值 */
  (e: "update", path: string, value: unknown): void
}>()

/** 弹窗是否开着 */
const open = ref(false)

/** 各元素当前值；非对象的一律当空对象编辑（内核校验是最后一道，此处只求不崩） */
const rows = computed(() =>
  props.node.items.map(el => (typeof el === "object" && el !== null && !Array.isArray(el) ? el : {}))
)

/** 本数组下改了几处，供摘要角标 */
const dirtyCount = computed(() => countUnder(props.dirty ?? [], props.node.path))

/** 本数组下有几处存不进去，供摘要角标 */
const errCount = computed(() => countUnder(Object.keys(props.errorOf), props.node.path))

/**
 * 第 i 个元素内的节点，路径为绝对
 * @param i 元素序号
 * @returns 节点清单
 */
function elementNodes(i: number): ReturnType<typeof nodesOf> {
  return nodesOf(props.node.itemSchema, `${props.node.path}[${i}]`, rows.value[i] as Record<string, unknown>)
}

/** 第 i 个元素自身的错误（元素整体非法，如「应为对象」），不属于任何字段 */
function rowError(i: number): string | undefined {
  return props.errorOf[`${props.node.path}[${i}]`]
}

/** 第 i 个元素里有没有错，供整张卡片标红 */
function rowBad(i: number): boolean {
  return countUnder(Object.keys(props.errorOf), `${props.node.path}[${i}]`) > 0
}

/** 把当前数组克隆一份，供改动后整体回传 —— 元素都是 JSON 安全的配置值 */
function clone(): unknown[] {
  return props.node.items.map(el => snapshot({ v: el }).v)
}

/**
 * 元素内某字段改动：剥掉元素前缀写进那一个元素，再把整个数组发上去
 * @param i 元素序号
 * @param path 绝对路径
 * @param value 新值
 */
function onField(i: number, path: string, value: unknown): void {
  const prefix = `${props.node.path}[${i}].`
  if (!path.startsWith(prefix)) return
  const next = clone()
  const el = (typeof next[i] === "object" && next[i] !== null ? next[i] : {}) as Record<string, unknown>
  setDeep(el, path.slice(prefix.length), value)
  next[i] = el
  emit("update", props.node.path, next)
}

/** 末尾添一个元素，按 schema 默认值物化（新元素即带上各字段的默认） */
function add(): void {
  emit("update", props.node.path, [...clone(), defaultsOf(props.node.itemSchema)])
}

/**
 * 删掉第 i 个元素
 * @param i 元素序号
 */
function remove(i: number): void {
  emit(
    "update",
    props.node.path,
    clone().filter((_, idx) => idx !== i)
  )
}
</script>

<template>
  <div class="objlist" :class="{ bad: errCount > 0 }">
    <div class="objlist-bar">
      <div class="objlist-label">
        <span class="s-label">{{ node.title }}</span>
        <p v-if="node.description" class="hint">{{ node.description }}</p>
      </div>
      <button type="button" class="objlist-open" @click="open = true">
        配置
        <span class="tag">{{ rows.length }} 项</span>
        <span v-if="dirtyCount > 0" class="tag">{{ dirtyCount }} 改</span>
        <span v-if="errCount > 0" class="tag err">{{ errCount }}</span>
      </button>
    </div>
  </div>

  <Modal :open="open" wide :title="node.title" @close="open = false">
    <p v-if="node.description" class="hint">{{ node.description }}</p>

    <!--
      元素增删带过渡，key 取序号：删中间一项使其后各项 key 前移，走 FLIP 补位而非各自离场，
      与键值对那边同一个取舍（见 SchemaField 的 kvRows）
    -->
    <TransitionGroup name="rowfx" tag="div" class="objlist-items">
      <div v-for="(row, i) in rows" :key="i" class="objlist-item" :class="{ bad: rowBad(i) }">
        <div class="objlist-item-head">
          <span class="hint">第 {{ i + 1 }} 项</span>
          <button v-if="!disabled" type="button" class="link" :aria-label="`删除第 ${i + 1} 项`" @click="remove(i)">
            删除
          </button>
        </div>
        <p v-if="rowError(i)" class="err">{{ rowError(i) }}</p>
        <template v-for="child in elementNodes(i)" :key="child.path">
          <SubForm
            v-if="child.kind === 'group'"
            :node="child"
            :error-of="errorOf"
            :dirty="dirty"
            :disabled="disabled"
            @update="(path, value) => onField(i, path, value)"
          />
          <ObjectList
            v-else-if="child.kind === 'list'"
            :node="child"
            :error-of="errorOf"
            :dirty="dirty"
            :disabled="disabled"
            @update="(path, value) => onField(i, path, value)"
          />
          <SchemaField
            v-else
            :schema="child.schema"
            :value="child.value"
            :path="child.path"
            :siblings="child.siblings"
            :error="errorOf[child.path]"
            :disabled="disabled"
            @update="(path, value) => onField(i, path, value)"
          />
        </template>
      </div>
    </TransitionGroup>

    <p v-if="rows.length === 0" class="hint">还没有任何一项。</p>
    <button v-if="!disabled" type="button" class="objlist-add" @click="add()">＋ 添加一项</button>
  </Modal>
</template>
