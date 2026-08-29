/**
 * 模块职责：服务器路径的拼接与面包屑拆解
 * 依赖方向：无依赖，纯函数
 * 生命周期：无状态
 * 注意事项：**分隔符一律由参数传入，不取浏览器所在系统的。** 面板与内核可以跑在两台机器上
 *          （手机浏览器打开 Linux 服务器的面板），用浏览器的分隔符拼服务器的路径必然出错。
 *          故 `GET /api/fs` 的响应里带着 `sep`，此处照用。
 *
 *          **Windows 的「最外层」是盘符列表，不是某个目录**，以空串表示：`""` 的子项是
 *          `C:\`、`D:\`，而 `C:\` 的上一级又是 `""`。类 Unix 上没有这一层，`/` 的上一级
 *          就是它自己。两种形态在此处以空串统一，拼接与拆解都要照顾到。
 */

/** 面包屑上的一节 */
export interface Crumb {
  /** 显示文案 */
  label: string
  /** 点它要跳到的绝对路径 */
  path: string
}

/**
 * 把一个条目名拼到目录后面
 *
 * 三种情形：最外层（盘符列表）下条目名本身就是完整的盘根；目录已以分隔符结尾
 * （`C:\` 与 `/`）时不再补一个；其余正常拼接。
 * @param dir 当前目录；空串表示最外层
 * @param name 条目名
 * @param sep 服务器的路径分隔符
 * @returns 拼接后的绝对路径
 */
export function joinPath(dir: string, name: string, sep: string): string {
  if (dir === "") return name
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

/**
 * 取一个路径的所在目录
 *
 * 用于「字段里填的是一个文件，浏览应从它所在的目录开始」。取不出目录时返回空串，
 * 由调用方交给内核决定起点。
 * @param target 绝对路径
 * @param sep 服务器的路径分隔符
 * @returns 所在目录；无从判断时空串
 */
export function dirOf(target: string, sep: string): string {
  const at = target.lastIndexOf(sep)
  if (at < 0) return ""
  // 保留根部的分隔符：`/etc` 的所在目录是 `/` 而不是空串，`C:\x` 的是 `C:\`
  const head = target.slice(0, at)
  if (head === "" || head.endsWith(":")) return `${head}${sep}`
  return head
}

/**
 * 拆成面包屑
 *
 * 首节是根（`C:\` 或 `/`），此后每节对应一层目录。最外层（空串）没有面包屑 ——
 * 那时显示的是盘符列表，本身就是最顶层，没有更上一层可回。
 * @param target 绝对路径；空串表示最外层
 * @param sep 服务器的路径分隔符
 * @returns 面包屑，自外向内
 */
export function crumbsOf(target: string, sep: string): Crumb[] {
  if (target === "") return []

  const parts = target.split(sep).filter(part => part !== "")
  const out: Crumb[] = []

  // 根节：Windows 上是 `C:\`（parts[0] 形如 `C:`），类 Unix 上是 `/`
  if (target.startsWith(sep)) {
    out.push({ label: sep, path: sep })
  } else {
    const head = parts.shift()
    if (head === undefined) return []
    out.push({ label: `${head}${sep}`, path: `${head}${sep}` })
  }

  let acc = out[0]?.path ?? sep
  for (const part of parts) {
    acc = joinPath(acc, part, sep)
    out.push({ label: part, path: acc })
  }
  return out
}
