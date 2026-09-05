/**
 * 模块职责：面板入口 —— 挂载 Vue 应用
 * 依赖方向：依赖 App.vue、全局样式与各页内置组件的登记
 * 生命周期：页面加载时执行一次
 * 注意事项：**内置组件的登记要在挂载之前完成**（登记是 import 的副作用）：否则第一帧的版面
 *          按「注册表为空」算出来，随后再补上，表现为卡片跳一下。
 *
 *          **面板插件同理，故挂载前要 await 它**，但它多两趟网络往返（拉清单、`import()`
 *          每个文件），内核没起来或某个插件的 js 卡在半路时，无限等意味着白屏。故加一道
 *          3 秒上限，超时即照常挂载 —— 迟到的插件仍会注册，代价是版面跳一下。
 */
import { createApp } from "vue"
import App from "./App.vue"
import { loadPanelPlugins } from "./panelload.js"
import { installTabScroll } from "./tabscroll.js"
import { initTheme } from "./theme.js"
import { initAppearance } from "./appearance.js"
import "./widgets/overview.js"
import "./styles.css"

/** 等面板插件的上限，超过即先挂载 */
const PANEL_LOAD_TIMEOUT_MS = 3000

/**
 * 至多等 `PANEL_LOAD_TIMEOUT_MS` 毫秒
 *
 * 不用 `AbortSignal.timeout` 加真正的中断：这里要的是「不再等」而非「不要了」，
 * 中断只会让一个已在下载中的插件半途失败 —— 而它本可以迟一点注册成功。
 * @param task 要等的事
 * @returns 无
 */
async function atMost(task: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    task.finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    }),
    new Promise<void>(resolve => {
      timer = setTimeout(() => {
        // 用 error 而非 warn：本项目的 lint 只放行 console.error（其余几个在
        // 浏览器的默认过滤下常被折叠起来，等于写了也看不见）
        console.error(`面板插件在 ${PANEL_LOAD_TIMEOUT_MS}ms 内没装完，先挂载页面；迟到的插件仍会出现`)
        resolve()
      }, PANEL_LOAD_TIMEOUT_MS)
    })
  ])
}

/**
 * 装完面板插件（或等到超时）之后挂载
 *
 * 不写成顶层 await：那要求把 vite 的构建目标抬到 es2022（默认的 `modules` 含不支持它的
 * chrome87），即为这一处入口改掉整个面板的浏览器基线。包一层 async 函数时序完全相同。
 * @returns 无
 */
async function boot(): Promise<void> {
  /*
   * 主题先接上：只是读一次 localStorage 与挂一个 matchMedia 监听，不发请求
   *
   * 放在等插件之前 —— 那一步最多要等 3 秒，而首帧的深浅由 index.html 的内联脚本
   * 定下，此处接手后续的「跟随系统」变化。
   */
  initTheme()
  initAppearance()
  await atMost(loadPanelPlugins())
  /*
   * 页签条的滚轮转横滚，装在挂载之前
   *
   * 事件委托在 `document` 上，与哪些组件已经渲染出来无关，故装在挂载前后皆可；放在前面
   * 是为了第一帧就生效 —— 页签条溢出时滑不动，那一下没人会重试。
   */
  installTabScroll()
  createApp(App).mount("#app")
}

void boot()
