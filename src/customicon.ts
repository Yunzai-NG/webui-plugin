/**
 * 自定义页面图片图标：仅读取插件声明的单个文件，返回可供 img 使用的数据 URL。
 * 不挂载插件目录；文件内容通过已有的鉴权页面清单返回。
 */
import { open, realpath } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"

const MAX_BYTES = 256 * 1024
const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".avif": "image/avif"
}

/**
 * 判定图标是否声明了文件路径（其余按 emoji/文本处理）。
 * @param icon 原始图标声明
 * @returns 是否为路径形式
 */
export function isImageIcon(icon: string): boolean {
  return /[/\\.:]/.test(icon)
}

/**
 * 读取相对插件根目录的图片，拒绝越界、符号链接逃逸及超大文件。
 * @param pluginRoot 插件根目录，不是 webadapter 目录
 * @param icon 图片相对路径
 * @returns 仅包含声明图片的数据 URL
 */
export async function loadImageIcon(pluginRoot: string, icon: string): Promise<string> {
  if (isAbsolute(icon) || /[\\:%?#\0]/.test(icon) || icon.split("/").includes("..")) {
    throw new Error("图标必须是插件根目录内的相对图片路径")
  }
  const mime = MIME[extname(icon).toLowerCase()]
  if (!mime) throw new Error("图标格式不支持")
  const root = await realpath(pluginRoot)
  const file = await realpath(resolve(root, icon))
  const rel = relative(root, file)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("图标路径越出插件目录")
  }
  const handle = await open(file, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) {
      throw new Error("图标必须是非空图片文件，大小不超过 256 KiB")
    }
    // 有界读取，文件在 stat 后增长也不会无限分配内存。
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (!length || length > MAX_BYTES) throw new Error("图标文件大小无效")
    return `data:${mime};base64,${buffer.subarray(0, length).toString("base64")}`
  } finally {
    await handle.close()
  }
}