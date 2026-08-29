<script setup lang="ts">
/**
 * 模块职责：一个格子里的组件 —— 渲染它，并在它抛错时只废掉这一格
 * 依赖方向：只依赖 registry 的类型；不认识栅格，也不认识具体页面
 * 生命周期：随所在格子
 * 注意事项：**失败隔离是本组件存在的唯一理由。** 组件的来源有三处（面板自身、面板插件、
 *          各功能插件的配置声明），后两处不由面板作者书写。若不隔离，一个面板插件里的
 *          一处笔误就会让整页白屏 —— 而白屏之后连「去哪儿把它关掉」都看不见。
 *
 *          `onErrorCaptured` 返回 false 阻止继续向上冒泡，错误止于这一格。代价是这类
 *          错误不再出现在浏览器控制台的未捕获错误里，故把错误原文一并显示在格子里。
 */
import { onErrorCaptured, ref } from "vue"
import type { WidgetDef } from "../registry.js"

defineProps<{
  /** 要渲染的组件定义 */
  def: WidgetDef
}>()

/** 出错的原文；为空串表示尚未出错 */
const failed = ref("")

onErrorCaptured(err => {
  failed.value = err instanceof Error ? err.message : String(err)
  return false
})
</script>

<template>
  <div v-if="failed !== ''" class="card wfail">
    <b>此组件加载失败</b>
    <p>{{ def.title }}</p>
    <p class="mono">{{ failed }}</p>
  </div>
  <component :is="def.component" v-else v-bind="def.props" />
</template>
