<script setup lang="ts">
/**
 * 模块职责：一套前缀与禁用的几栏 —— 群配置与规则组共用
 * 依赖方向：依赖 PickSelect / ChipInput / DisabledPicker 与 grouprules 的类型
 * 生命周期：随所在编辑区
 */
import { collapseHooks } from "../collapse.js"
import ChipInput from "./ChipInput.vue"
import DisabledPicker from "./DisabledPicker.vue"
import PickSelect from "./PickSelect.vue"
import { prefixText, type PrefixMode, type ScopeBody } from "../grouprules.js"
import type { CommandItem } from "../types.js"

const props = defineProps<{
  /** 当前那一套 */
  modelValue: ScopeBody
  /** 全部命令 */
  commands: readonly CommandItem[]
  /** 注册了命令的目录插件名 */
  plugins: readonly string[]
  /** 注册了命令的单文件 JS 名 */
  scripts: readonly string[]
  /** 全局前缀，写进「沿用全局」那一项的说明 */
  globalPrefix: readonly string[]
  /** 控件 id 前缀，同一页里有两份时免得撞 */
  idBase: string
}>()

const emit = defineEmits<{
  /** 改了 */
  "update:modelValue": [value: ScopeBody]
}>()

/**
 * 改一项
 * @param patch 要改的项
 */
function set(patch: Partial<ScopeBody>): void {
  emit("update:modelValue", { ...props.modelValue, ...patch })
}
</script>

<template>
  <div class="scope-body">
    <div class="sc-field">
      <span class="s-label">前缀</span>
      <PickSelect
        :id="`${idBase}-mode`"
        :model-value="modelValue.prefixMode"
        label="前缀"
        :options="[
          { value: 'inherit', label: '沿用全局', note: globalPrefix.length === 0 ? '不要前缀' : prefixText(globalPrefix) },
          { value: 'custom', label: '单独设' },
          { value: 'none', label: '不要前缀' }
        ]"
        @update:model-value="v => set({ prefixMode: v as PrefixMode })"
      />
      <Transition name="expand" v-on="collapseHooks">
        <div v-if="modelValue.prefixMode === 'custom'" class="sc-reveal">
          <ChipInput
            :model-value="modelValue.prefix"
            :options="[]"
            label="前缀"
            placeholder="输入前缀后回车，可加几个"
            free
            @update:model-value="v => set({ prefix: v })"
          />
        </div>
      </Transition>
    </div>

    <div class="sc-field">
      <label class="check">
        <input type="checkbox" :checked="modelValue.ownDisabled" @change="set({ ownDisabled: ($event.target as HTMLInputElement).checked })" />
        <span class="checkmark"></span>
        <span class="s-label">单独设禁用</span>
      </label>
      <p class="hint">打开后全局禁用对这里不再生效，只按下面这份来。</p>
      <Transition name="expand" v-on="collapseHooks">
        <div v-if="modelValue.ownDisabled" class="sc-reveal">
          <DisabledPicker
            :model-value="modelValue.disabled"
            :commands="commands"
            :plugins="plugins"
            :scripts="scripts"
            @update:model-value="v => set({ disabled: v })"
          />
        </div>
      </Transition>
    </div>
  </div>
</template>