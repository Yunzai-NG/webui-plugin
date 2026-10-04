/**
 * 模块职责：把文本交给浏览器 —— 复制到剪贴板、存成文件
 * 依赖方向：仅依赖浏览器 API
 * 生命周期：无状态
 * 注意事项：剪贴板只在安全上下文（https 或本机地址）可用，其余情形抛错，由调用方提示。
 */

/**
 * 复制文本到剪贴板
 * @param text 文本
 * @throws 浏览器不允许访问剪贴板时
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard === undefined) throw new Error("当前页面不是安全上下文，浏览器不允许访问剪贴板")
  await navigator.clipboard.writeText(text)
}

/**
 * 把文本存成文件
 * @param name 文件名
 * @param text 内容
 * @param mime 媒体类型
 */
export function downloadText(name: string, text: string, mime = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 把任意名字转成可用的文件名
 * @param name 名字
 * @returns 去掉文件系统保留字符后的文件名
 */
export function fileNameOf(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120)
  return safe === "" ? "export" : safe
}
