/**
 * 模块职责：主题桥 —— 把当前主题、明暗与公开令牌的计算值发给扩展页的 iframe
 * 依赖方向：依赖 themes / scheme / appearance（读当前状态）与 themeview（拼消息）
 * 生命周期：由 CustomPageView 挂载与拆除，随页面切换
 * 注意事项：扩展页装在不带 `allow-same-origin` 的 iframe 里（见 CustomPageView.vue），面板的样式与变量
 *          都进不去 —— 那是安全设计，不能改。这条桥是让它跟着主题走的唯一办法：页面引一行
 *          `/theme-sdk.js`，SDK 收到消息后把令牌写成自己根上的 CSS 变量。
 *
 *          **三个时机发**：iframe 加载完、SDK 发来 `ready`（它可能比 load 早或晚）、主题或明暗变了。
 *          最后一种要等新样式表加载完再读令牌（`themeRevision`），读早了拿到的是旧主题的值。
 *
 *          消息里只有令牌、地址与几个开关，不是敏感数据；`targetOrigin` 只能是 `"*"`，理由同数据桥。
 */
import { watch } from "vue"
import { appearance, motionEnabled } from "./appearance.js"
import { schemeMode } from "./scheme.js"
import { currentTheme, themeRevision } from "./themes.js"
import { PUBLIC_TOKENS, THEME_BRIDGE_KIND, themeMessageOf } from "./themeview.js"

/** 公开令牌此刻的计算值 */
function tokensNow(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const name of PUBLIC_TOKENS) {
    const value = style.getPropertyValue(name).trim()
    if (value !== "") out[name] = value
  }
  return out
}

/**
 * 装上主题桥
 * @param frame 目标 iframe 元素的取值函数
 * @returns 拆除函数
 */
export function attachThemeBridge(frame: () => HTMLIFrameElement | null): () => void {
  /** 发一次 */
  const send = (): void => {
    const target = frame()?.contentWindow
    if (target === null || target === undefined) return
    const msg = themeMessageOf({
      theme: currentTheme.value,
      scheme: schemeMode.value,
      tokens: tokensNow(),
      origin: location.origin,
      lowPower: appearance.value.prefs.lowPower,
      motion: motionEnabled()
    })
    target.postMessage(msg, "*")
  }

  /**
   * SDK 起来之后会发一条 ready
   * @param event 消息事件
   */
  const onMessage = (event: MessageEvent): void => {
    const el = frame()
    if (el === null || event.source !== el.contentWindow) return
    const data = event.data as { kind?: unknown; type?: unknown } | null
    if (data?.kind === THEME_BRIDGE_KIND && data.type === "ready") send()
  }

  /** iframe 每次（重新）加载完 */
  const onLoad = (): void => send()

  let bound: HTMLIFrameElement | null = null
  /** iframe 元素换了就把 load 监听挪过去 */
  const bind = (): void => {
    const el = frame()
    if (el === bound) return
    bound?.removeEventListener("load", onLoad)
    el?.addEventListener("load", onLoad)
    bound = el
  }

  window.addEventListener("message", onMessage)
  const stopWatch = watch(
    [themeRevision, schemeMode, () => appearance.value],
    () => {
      bind()
      send()
    },
    { deep: true, flush: "post" }
  )
  const stopFrame = watch(frame, () => bind(), { flush: "post", immediate: true })

  return () => {
    window.removeEventListener("message", onMessage)
    bound?.removeEventListener("load", onLoad)
    stopWatch()
    stopFrame()
  }
}
