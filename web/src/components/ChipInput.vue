<script setup lang="ts">
/**
 * 模块职责：一个装着若干「胶囊」的输入框 —— 已选的每项一枚，× 删掉，+ 从没选过的里挑，也能直接敲进去
 * 依赖方向：只依赖 vue
 * 生命周期：随所在表单
 * 注意事项：候选清单就地展开在框下，不用浮层：它多半开在右侧抽屉里，浮层要算位置、还会被抽屉的滚动裁掉。
 *          点在外面即收起。
 *          候选只列没选过的；敲的字同时筛候选，回车把它原样加进去（候选里没有的也行，比如还没装的插件名）。
 */
import { computed, nextTick, ref } from "vue"
import { collapseHooks, pinLeaving } from "../collapse.js"
import { onClickOutside } from "../outside.js"

/** 一个候选 */
export interface ChipOption {
  /** 存进去的值 */
  value: string
  /** 显示的字 */
  label: string
  /** 跟在后面的灰字，如「整个插件」、群号 */
  note?: string
}

const props = defineProps<{
  /** 已选的值 */
  modelValue: readonly string[]
  /** 候选 */
  options: readonly ChipOption[]
  /** 框里没东西时的提示 */
  placeholder?: string
  /** 读屏用的名字 */
  label: string
  /** 能不能敲进候选之外的值 */
  free?: boolean
}>()

const emit = defineEmits<{
  /** 改了 */
  "update:modelValue": [value: string[]]
}>()

const open = ref(false)
const query = ref("")
const input = ref<HTMLInputElement>()
const root = ref<HTMLElement>()

onClickOutside(
  root,
  () => {
    open.value = false
    query.value = ""
  },
  () => open.value
)

/** 值 → 候选，给胶囊找显示的字 */
const byValue = computed(() => new Map(props.options.map(o => [o.value, o])))

/** 没选过、且对得上筛选字的候选 */
const left = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.options
    .filter(o => !props.modelValue.includes(o.value))
    .filter(o => q === "" || `${o.label} ${o.note ?? ""} ${o.value}`.toLowerCase().includes(q))
    .slice(0, 60)
})

/**
 * 加一项
 * @param value 值
 */
function add(value: string): void {
  const v = value.trim()
  if (v === "" || props.modelValue.includes(v)) return
  emit("update:modelValue", [...props.modelValue, v])
  query.value = ""
}

/**
 * 删一项
 * @param value 值
 */
function remove(value: string): void {
  emit("update:modelValue", props.modelValue.filter(v => v !== value))
}

/** 打开候选并把光标放进框里 */
async function openList(): Promise<void> {
  open.value = !open.value
  await nextTick()
  if (open.value) input.value?.focus()
}

/** 回车：有完全对上的候选取它，否则（允许时）原样加 */
function onEnter(): void {
  const q = query.value.trim()
  if (q === "") return
  const hit = left.value.find(o => o.value === q || o.label === q) ?? (left.value.length === 1 ? left.value[0] : undefined)
  if (hit !== undefined) add(hit.value)
  else if (props.free === true) add(q)
}
</script>

<template>
  <div ref="root" class="chip-input">
    <TransitionGroup tag="div" name="pill" class="chip-box" role="group" :aria-label="label" @click.self="void openList()" @before-leave="pinLeaving">
      <span v-for="v in modelValue" :key="v" class="cin-chip">
        {{ byValue.get(v)?.label ?? v }}<small v-if="byValue.get(v)?.note" class="hint">{{ byValue.get(v)?.note }}</small>
        <button type="button" class="chip-x" :aria-label="`删掉 ${byValue.get(v)?.label ?? v}`" @click="remove(v)">×</button>
      </span>
      <span v-if="modelValue.length === 0 && !open" key="@empty" class="hint chip-empty" @click="void openList()">{{ placeholder ?? "未添加" }}</span>
      <button key="@add" type="button" class="chip-add" :aria-expanded="open" :aria-label="`添加${label}`" @click="void openList()">+</button>
    </TransitionGroup>
    <Transition name="expand" v-on="collapseHooks">
    <div v-if="open" class="chip-pick">
      <input
        ref="input"
        v-model="query"
        type="search"
        :placeholder="options.length === 0 ? '输入后回车' : free ? '筛选，或直接输入后回车' : '筛选'"
        :aria-label="`筛选${label}`"
        @keydown.enter.prevent="onEnter()"
        @keydown.esc.stop.prevent="open = false"
      />
      <ul class="chip-options">
        <li v-for="o in left" :key="o.value">
          <button type="button" @click="add(o.value)">
            <span>{{ o.label }}</span><small v-if="o.note" class="hint">{{ o.note }}</small>
          </button>
        </li>
        <li v-if="left.length === 0 && options.length > 0" class="hint">{{ query.trim() !== "" && free ? "回车直接加进去" : "没有可加的了" }}</li>
      </ul>
    </div>
    </Transition>
  </div>
</template>
