<script setup lang="ts">
/**
 * 模块职责：页头 —— 图标 + 标题 + 副标题 + 右侧动作组
 * 依赖方向：依赖 router 的 ROUTES（取图标与标题）
 * 生命周期：随所在视图
 * 注意事项：**只收一个 `route` 标识，图标与标题由 `ROUTES` 供给** —— 页标题与导航文案本是同一个词，
 *          图标侧栏也要用；逐页传入等于把同一份事实抄三遍。那份表是唯一出处（见 `router.ts`）。
 *
 *          标识未登记时退化为显示标识本身，而非空白页头 —— 空白无从说明原因。
 *
 *          **每个页面有且只有一个 `h1`**，由本组件产出。图标标注 `aria-hidden`：它重复了紧邻的
 *          标题文字，读屏器再念一遍纯属噪声。
 *
 *          动作组是具名插槽而非 props：各页的动作在数量、类型与禁用条件上没有共性。**只放页级动作**
 *          —— 筛选一类的控件属于内容区的工具条，混在一处会让两层看起来是同一层。
 *
 *          副标题另有一个 `meta` 插槽，同行紧随其后。日志页的连接状态徽标属于这一处：它是对副标题
 *          那句话的即时限定，且并不可点，放进动作组会与可点击项混在一起。
 *
 *          `title` 是**唯一**可覆盖那份表的一项，只为一种页：内容由插件提供、标题在运行时才知道
 *          （扩展页面）。这一项不该推广到别处 —— 其余页面的标题与导航文案必须是同一个词，
 *          各页自己传一遍就会出现「侧栏叫 A、页头叫 B」而无人察觉。
 *
 *          标题右侧另有 `titleMeta` 插槽，放「这一页由谁提供」一类的出处说明：它限定的是标题
 *          本身而非副标题那句话，故与 `h1` 同行、以淡色区分主次。
 */
import { computed } from "vue"
import AppIcon from "./AppIcon.vue"
import { routeOf } from "../router.js"

/** 标识未登记时的图标：一个空心圆，读作「未知的页」 */
const UNKNOWN = "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18"

const props = defineProps<{
  /** 页面标识，须为 ROUTES 中的 id */
  route: string
  /** 副标题，一句话说明本页呈现什么 */
  sub?: string
  /** 覆盖标题；缺省取 ROUTES 里的导航文案。只给运行时才知道标题的页用 */
  title?: string
}>()

/** 实际显示的标题 */
const heading = computed(() => {
  const given = props.title
  if (given !== undefined && given !== "") return given
  return def.value?.label ?? props.route
})

/** 当前页面的定义 */
const def = computed(() => routeOf(props.route))
</script>

<template>
  <header class="page-head">
    <span class="page-icon">
      <AppIcon :path="def?.icon ?? UNKNOWN" />
    </span>
    <div class="page-titles">
      <!-- 标题右侧那行淡色小字与标题同行：它是对「这是谁的页」的限定，
           另起一行会读成一条独立的说明 -->
      <h1>
        {{ heading }}
        <small v-if="$slots.titleNote" class="page-note"><slot name="titleNote" /></small>
      </h1>
      <p v-if="sub !== undefined || $slots.meta" class="sub">
        {{ sub }}
        <slot name="meta" />
      </p>
    </div>
    <div v-if="$slots.actions" class="page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
