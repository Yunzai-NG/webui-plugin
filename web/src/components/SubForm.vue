<script setup lang="ts">
/**
 * 模块职责：把一个子表单分组渲染为带标题的可折叠区块，其内可再含分组
 * 依赖方向：依赖 SchemaField、AppIcon、subform.ts 与 collapse.ts
 * 生命周期：随父表单；展开状态是本组件自己的
 * 注意事项：**层级由盒子表达，不由缩进表达。** 此前嵌套对象被摊成一串平行的字段行，
 *          只在左侧画一道竖线加一段缩进（`--indent`）—— 一组字段读起来与它上下的字段
 *          同级，那道线要对照着数才认得出属于谁。
 *
 *          **本组件递归引用自己**：`<SubForm>` 在自己的模板里出现。`<script setup>` 的
 *          单文件组件可按文件名自引用，无须在别处登记。
 *
 *          **组内有错时强制展开。** 保存失败后标红的字段可能正躺在一个折起来的组里，
 *          此时使用者看到的是「它说有错，可我这一栏没有红字」。故 `open` 是「自己的
 *          展开状态**或**组内有错」，而不是单纯的 ref —— 后者要靠 watch 去改，而 watch
 *          改完之后使用者再手动折起来，下一次校验就不会再展开了。
 */
import { computed, ref } from "vue"
import AppIcon from "./AppIcon.vue"
import SchemaField from "./SchemaField.vue"
import ObjectList from "./ObjectList.vue"
import { collapseHooks } from "../collapse.js"
import { countUnder, type GroupNode } from "../subform.js"

const props = defineProps<{
  /** 本组 */
  node: GroupNode
  /** 路径 → 错误消息 */
  errorOf: Record<string, string>
  /** 改动过的路径 */
  dirty?: readonly string[]
  /** 是否整体只读 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 组内某条路径的值发生变化 */
  (e: "update", path: string, value: unknown): void
}>()

/** 展开态的折角，与侧栏那一处同形 —— 一律 svg path，理由见 App.vue 的 CARET_UP */
const CARET_UP = "M7 14l5-5 5 5"
/** 收起态的折角 */
const CARET_DOWN = "M7 10l5 5 5-5"

/** 本组是否被使用者展开 */
const unfolded = ref(false)

/** 组内改动数，含更深层的分组 */
const dirtyCount = computed(() => countUnder(props.dirty ?? [], props.node.path))

/** 组内错误数 */
const badCount = computed(() => countUnder(Object.keys(props.errorOf), props.node.path))

/**
 * 实际是否展开
 *
 * 组内有错时一律展开，且此时那枚按钮点了也合不上 —— 合上就又回到「有红字看不见」。
 */
const open = computed(() => unfolded.value || badCount.value > 0)
</script>

<template>
  <section class="subform" :class="{ bad: badCount > 0 }">
    <!--
      标题行整行可点

      不只把折角做成按钮：一块分组的标题条是使用者预期能点的整个区域，只有 16px 的折角
      可点会让人以为这一组展不开。`aria-expanded` 落在这枚按钮上，读屏器据此念出状态。
    -->
    <button
      type="button"
      class="subform-head"
      :aria-expanded="open"
      :aria-controls="`${node.path}__body`"
      @click="unfolded = !unfolded"
    >
      <span class="subform-title">
        {{ node.title }}
        <span v-if="dirtyCount > 0" class="tag">{{ dirtyCount }}</span>
        <span v-if="badCount > 0" class="tag err">{{ badCount }}</span>
      </span>
      <!-- 说明跟着标题一起折起来：它说的是这一组是什么，组收起时那句话无处安放 -->
      <span v-if="node.description !== undefined && open" class="hint">{{ node.description }}</span>
      <AppIcon class="subform-caret" :path="open ? CARET_UP : CARET_DOWN" />
    </button>

    <Transition name="expand" v-on="collapseHooks">
      <div v-if="open" :id="`${node.path}__body`" class="subform-body">
        <!--
          组内节点：叶子照常成行，子分组递归成块

          `key` 取路径而非序号：`showWhen` 显隐会让同一序号先后指向不同字段，
          那时 Vue 会复用上一个的 DOM，表现为「输入框里留着另一个字段的值」。
        -->
        <template v-for="child in node.children" :key="child.path">
          <SubForm
            v-if="child.kind === 'group'"
            :node="child"
            :error-of="errorOf"
            :dirty="dirty"
            :disabled="disabled"
            @update="(path, value) => emit('update', path, value)"
          />
          <ObjectList
            v-else-if="child.kind === 'list'"
            :node="child"
            :error-of="errorOf"
            :dirty="dirty"
            :disabled="disabled"
            @update="(path, value) => emit('update', path, value)"
          />
          <SchemaField
            v-else
            :schema="child.schema"
            :value="child.value"
            :path="child.path"
            :siblings="child.siblings"
            :error="errorOf[child.path]"
            :disabled="disabled"
            @update="(path, value) => emit('update', path, value)"
          />
        </template>
      </div>
    </Transition>
  </section>
</template>
