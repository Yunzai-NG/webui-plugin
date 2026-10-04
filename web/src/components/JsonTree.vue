<script setup lang="ts">
/**
 * 模块职责：以可折叠的树形展示一个 JSON 值
 * 依赖方向：只依赖 vue；按文件名递归引用自身
 * 生命周期：随调用方
 * 注意事项：前两层默认展开，更深的层级默认折叠；每层最多渲染 CHILD_MAX 项，避免大数组卡住页面。
 */
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    /** 值 */
    value: unknown
    /** 键名或下标；根节点不给 */
    name?: string | number
    /** 深度，根为 0 */
    depth?: number
  }>(),
  { name: undefined, depth: 0 }
)

/** 每层渲染的子项上限 */
const CHILD_MAX = 500

const isBranch = computed(() => typeof props.value === "object" && props.value !== null)
const isArray = computed(() => Array.isArray(props.value))

/** 子项，形如 [键名或下标, 值] */
const entries = computed<[string | number, unknown][]>(() => {
  const v = props.value
  if (Array.isArray(v)) return v.map((x: unknown, i) => [i, x])
  if (typeof v === "object" && v !== null) return Object.entries(v)
  return []
})

const shown = computed(() => entries.value.slice(0, CHILD_MAX))

// 括号在 script 里拼：模板插值中出现 `}}` 会被解析器当成插值的结尾
const branchLabel = computed(() =>
  isArray.value ? `数组 [${entries.value.length}]` : `对象 {${entries.value.length}}`
)

/** 叶子的显示文本与配色 */
const leaf = computed(() => {
  const v = props.value
  if (v === null || v === undefined) return { text: "null", cls: "jt-null" }
  if (typeof v === "string") return { text: JSON.stringify(v), cls: "jt-str" }
  if (typeof v === "number") return { text: String(v), cls: "jt-num" }
  if (typeof v === "boolean") return { text: String(v), cls: "jt-bool" }
  return { text: String(v), cls: "jt-null" }
})
</script>

<template>
  <details v-if="isBranch" class="jt" :open="depth < 2">
    <summary>
      <template v-if="name !== undefined">
        <span class="jt-key">{{ name }}</span><span class="jt-meta">: </span>
      </template>
      <span class="jt-meta">{{ branchLabel }}</span>
    </summary>
    <div class="jt-body">
      <JsonTree v-for="[k, v] in shown" :key="k" :value="v" :name="k" :depth="depth + 1" />
      <p v-if="entries.length === 0" class="jt-meta jt-leaf">（空）</p>
      <p v-else-if="entries.length > CHILD_MAX" class="jt-meta jt-leaf">
        另有 {{ entries.length - CHILD_MAX }} 项未显示，请切换到「编辑」查看全文
      </p>
    </div>
  </details>
  <div v-else class="jt-leaf">
    <template v-if="name !== undefined">
      <span class="jt-key">{{ name }}</span><span class="jt-meta">: </span>
    </template>
    <span :class="leaf.cls">{{ leaf.text }}</span>
  </div>
</template>
