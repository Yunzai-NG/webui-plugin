/**
 * 模块职责：外部来的链接只放行 http(s)
 * 依赖方向：无依赖
 * 生命周期：纯函数
 * 注意事项：**插件的 `homepage`、`repository`、市场索引里的地址、适配器登录步骤给的网址都不是面板写的。**
 *          Vue 不会替 `:href` 过滤 `javascript:`，一条写着 `javascript:…` 的主页一点即在面板的源里执行，
 *          而访问令牌就在这个源的 localStorage 里。索引可以换成任意镜像，插件包谁都能发，故一律在这里收口。
 */

/**
 * 把一个外部来的地址收窄成可点的链接
 * @param raw 地址
 * @returns http(s) 的绝对地址；别的协议、相对地址与解析不了的都给 undefined
 */
export function safeHref(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const text = raw.trim()
  if (text === "") return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
}
