<script setup lang="ts">
/**
 * 模块职责：扩展页面 —— 列出各插件注册的页面，把选中那一个装进受限 iframe
 * 依赖方向：依赖 api / router / custombridge / PageHeader
 * 生命周期：随路由切换；桥随本组件装拆
 * 注意事项：**iframe 的 sandbox 刻意不含 `allow-same-origin`** —— 插件页面与面板同源的话，
 *          里面的脚本可以直接读 localStorage 里的面板令牌，再以面板的身份调用任何写接口，
 *          「只读」便无从谈起。去掉之后它的源是不透明的，取数只能走 `custombridge` 那道白名单闸。
 *          代价是插件页面不能用 localStorage 存自己的东西（同源策略下不透明源无存储权限），
 *          要存就存到自己的 node 侧。
 *
 *          **页面标识就是插件目录名**，由服务端担保全局唯一（见 custompage.ts）—— 故按 `id` 找页不会串到
 *          另一家的页面上。不收插件自报的 id 正是为了这一条。
 *
 *          高度不写 `calc(100vh - …)`：真正在滚的是 `.main`（见 styles.css 的宽屏增强），
 *          减一个手数出来的常数在窄屏顶栏在场时必然差一截。用 `flex: 1` 让它吃掉本页剩余高度。
 */
import { computed, onMounted, onUnmounted, ref } from "vue"
import { getAt } from "../api.js"
import { errorText } from "../format.js"
import { currentQuery } from "../router.js"
import { attachBridge } from "../custombridge.js"
import PageHeader from "../components/PageHeader.vue"

/** 一个已挂载的插件页面，字段与服务端 `CustomPage` 一一对应 */
interface Page {
  /** 页面标识，即插件目录名 */
  id: string
  /** 导航与页头文案 */
  title: string
  /** 一句话说明 */
  sub?: string
  /** 提供者显示名 */
  provider: string
  /** 页面 HTML 地址 */
  url: string
  /** 插件描述符中的 emoji 或图片数据 */
  icon?: string
  /** 由服务端清单授权，不接受 iframe 自报 */
  configurable?: boolean
}

const pages = ref<Page[]>([])
const failure = ref("")
const loading = ref(true)
const frame = ref<HTMLIFrameElement | null>(null)

/**
 * 当前页面
 *
 * 无 `name` 参数时取第一个，使左侧点「扩展页面」主项就能看到内容而非空页。
 */
const page = computed<Page | undefined>(() => {
  const key = currentQuery.value.name
  if (key === undefined || key === "") return pages.value[0]
  return pages.value.find(item => item.id === key) ?? pages.value[0]
})

const frameUrl = computed(() => page.value?.url ?? "")

/**
 * 页头标题：取当前页面自己的标题，没有页面时退回导航文案
 *
 * 不一律显示「扩展页面」：使用者点进来看的是「消息统计」，页头再说一遍那个分类名等于
 * 白占一行 —— 而「这一页叫什么」在标题栏之外没有别处可看。
 */
const headTitle = computed(() => page.value?.title ?? "")

/**
 * 页头副标题
 *
 * 出处不写在这里而在标题右侧的淡色标记上（见模板的 `meta` 插槽）：副标题是「这一页
 * 做什么」，出处是「它由谁提供」，两件事挤成一句会把前者挤掉。
 */
const headSub = computed(() => {
  const current = page.value
  if (current === undefined) return "插件注册的页面"
  return current.sub ?? ""
})

onMounted(async () => {
  try {
    pages.value = (await getAt<{ pages?: Page[] }>("/plugin/webui/custom-pages")).pages ?? []
  } catch (err) {
    failure.value = errorText(err)
  } finally {
    loading.value = false
  }
})

// 插件标识由这里给，不收 iframe 自报的：否则一个插件的页面填上别人的名字就能读另一家的接口
const detach = attachBridge(
  () => frame.value,
  () => page.value?.id ?? "",
  () => page.value?.configurable === true
)
onUnmounted(detach)
</script>

<template>
  <div class="custom-page">
    <!-- 标题取页面自己的名字，出处另作一枚淡色标记跟在标题后：两者是不同的事，
         挤进同一句会让「这一页做什么」被出处挤掉 -->
    <PageHeader route="custom" :title="headTitle" :sub="headSub" :emoji="page?.icon ?? '📄'">
      <template v-if="page !== undefined" #titleNote>
        <span class="page-from" :title="`由插件「${page.provider}」注册的页面`">
          由 {{ page.provider }} 提供
        </span>
      </template>
    </PageHeader>

    <p v-if="loading" class="sub">正在读取已挂载的页面…</p>

    <div v-else-if="failure !== ''" class="card">
      <p class="sub">{{ failure }}</p>
    </div>

    <!--
      沙箱只开两项：脚本与表单。不给 `allow-same-origin`（理由见文件头），
      也不给 `allow-top-navigation` —— 插件页面把整个面板导走不该是它能做到的事。
      `referrerpolicy` 取 no-referrer：页面里若引了外部资源，面板的地址不必随之外发。
    -->
    <div v-else-if="frameUrl !== ''" class="custom-frame">
      <iframe
        ref="frame"
        :key="frameUrl"
        :src="frameUrl"
        :title="page?.title ?? '自定义页面'"
        sandbox="allow-scripts allow-forms"
        referrerpolicy="no-referrer"
        loading="lazy"
      />
    </div>

    <div v-else class="card">
      <p>没有已挂载的扩展页面。</p>
      <p class="hint">
        插件在自己目录下建 <code>webadapter/index.js</code> 并导出一个页面描述符即可在此出现，
        每个插件一页。
      </p>
    </div>
  </div>
</template>
