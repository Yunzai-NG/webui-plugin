<script setup lang="ts">
/**
 * 模块职责：每账号重连覆盖那四项的输入 —— 「添加账号」与「配置」模态两处共用
 * 依赖方向：依赖 duration 与 retry 的纯函数；不认识 api，也不认识账号页的任何状态
 * 生命周期：随调用方
 * 注意事项：**抽成组件而不是在两处各写一遍**：这四项的文案里带着「留空即跟随全局，当前为 X」
 *          这类必须与内核语义对齐的话（尤其 `limit: 0` 是「一直重连」而非「不重连」），
 *          抄一份的症状是改了一处、另一处继续说着旧话，而两处说法不一时使用者只会更糊涂。
 *
 *          **`id` 用 `useId()` 生成而非写死。** 新建表单与编辑模态可以同时在 DOM 里
 *          （模态开着时下方那张表单并未卸载），写死 `id="retryLimit"` 会得到两个同名元素 ——
 *          `<label for>` 只认第一个，于是点模态里的标题会去聚焦背后那张表单的输入框。
 *
 *          **一律不给默认值**：预先填上此刻的全局值等于把「跟随全局」偷换成「此刻的全局值」，
 *          而后者从此不跟着全局改动走，症状是「我改了全局间隔，这个号却不听」。
 */
import { computed, useId } from "vue"
import { DUR_UNITS } from "../duration.js"
import { globalNote, retryFormOf, retryOverrideOf } from "../retry.js"
import type { GlobalRetry, RetryForm } from "../retry.js"

/**
 * 表单态，四项皆字符串 —— 空串即「跟随全局」（见 `retry.ts` 文件头）
 *
 * 各输入框直接改这个对象上的字段：它就是调用方 `ref` 里的那一个对象，改动即刻可见。
 * 整体替换只发生在「一并改回跟随全局」，那一次才走 `update:modelValue`。
 */
const form = defineModel<RetryForm>({ required: true })

defineProps<{
  /** 全局四项的当前值，只为把「跟随全局」说成一个具体的数；读不到的项缺席 */
  global: GlobalRetry
}>()

/** 本组件这一份实例的 id 前缀，避免同页两份表单撞名 */
const uid = useId()

/** 此刻填了至少一项覆盖 */
const customized = computed(() => retryOverrideOf(form.value) !== null)

/** 把四项一并改回跟随全局 */
function clear(): void {
  form.value = retryFormOf(undefined)
}
</script>

<template>
  <!--
    与适配器那张表单**不是一类东西**，故单独成节而不混进 SchemaForm：那张表由适配器的
    `accountSchema` 驱动（「这个号的 WS 地址与 token 是什么」），而这四项归内核所有 ——
    重连是内核替所有适配器统一做的事，适配器根本不参与。混进去就得要求每个适配器作者
    各自声明一遍这四项，于是同一件事有 N 份声明，且哪个适配器忘了写，它的账号就没有
    这个能力。
  -->
  <div class="subsect">
    <h3>重连策略</h3>
    <p class="hint">
      四项各自可留空，留空的那项跟随全局设置（配置页 → 适配器）。这四项由内核统一执行，与适配器无关。
    </p>

    <div class="field">
      <label :for="`${uid}-limit`">重连次数上限</label>
      <input :id="`${uid}-limit`" v-model="form.limit" type="number" min="0" max="1000" step="1" placeholder="跟随全局" />
      <p class="hint">{{ globalNote("limit", global) }}。填 0 表示一直重连；连上一次即归零。</p>
    </div>

    <div class="field">
      <label :for="`${uid}-interval`">首次重连间隔</label>
      <div class="dur">
        <input :id="`${uid}-interval`" v-model="form.interval" type="number" min="0" placeholder="跟随全局" />
        <select v-model="form.intervalUnit" aria-label="首次重连间隔的单位">
          <option v-for="unit in DUR_UNITS" :key="unit.value" :value="unit.value">{{ unit.label }}</option>
        </select>
      </div>
      <p class="hint">{{ globalNote("interval", global) }}。第一次失败之后等多久再试。</p>
    </div>

    <div class="field">
      <label :for="`${uid}-maxInterval`">重连间隔上限</label>
      <div class="dur">
        <input :id="`${uid}-maxInterval`" v-model="form.maxInterval" type="number" min="0" placeholder="跟随全局" />
        <select v-model="form.maxIntervalUnit" aria-label="重连间隔上限的单位">
          <option v-for="unit in DUR_UNITS" :key="unit.value" :value="unit.value">{{ unit.label }}</option>
        </select>
      </div>
      <p class="hint">{{ globalNote("maxInterval", global) }}。退避增长到此为止，不再变长。</p>
    </div>

    <div class="field">
      <label :for="`${uid}-factor`">退避倍率</label>
      <input :id="`${uid}-factor`" v-model="form.factor" type="number" min="1" max="10" step="0.1" placeholder="跟随全局" />
      <p class="hint">
        {{ globalNote("factor", global) }}。每失败一次把等待乘上这个数；填 1 即不退避、始终按首次间隔重试。
      </p>
    </div>

    <button :disabled="!customized" @click="clear()">四项一并改回跟随全局</button>
  </div>
</template>
