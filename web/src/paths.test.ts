/**
 * 模块职责：`paths.ts` 的用例 —— 拼接、所在目录与面包屑
 * 依赖方向：测试文件，只依赖被测模块
 * 生命周期：纯函数，无夹具
 * 注意事项：每条都同时覆盖两种分隔符。**这些函数在 Windows 上跑，却必须对 Linux 的
 *          路径同样正确** —— 面板与内核可以是两台机器，而错误的表现只是「面包屑少一节」
 *          或「拼出 `C:\\Users`」，不会抛错。
 */
import { describe, expect, it } from "vitest"
import { crumbsOf, dirOf, joinPath } from "./paths.js"

const WIN = "\\"
const NIX = "/"

describe("拼接", () => {
  it("普通目录后接一个分隔符", () => {
    expect(joinPath("C:\\Users", "x", WIN)).toBe("C:\\Users\\x")
    expect(joinPath("/etc", "nginx", NIX)).toBe("/etc/nginx")
  })

  it("**已以分隔符结尾时不再补** —— 否则得到 C:\\\\Users", () => {
    expect(joinPath("C:\\", "Users", WIN)).toBe("C:\\Users")
    expect(joinPath("/", "etc", NIX)).toBe("/etc")
  })

  it("最外层（盘符列表）下条目名本身就是完整盘根", () => {
    expect(joinPath("", "C:\\", WIN)).toBe("C:\\")
  })
})

describe("所在目录", () => {
  it("文件的所在目录", () => {
    expect(dirOf("C:\\Users\\x\\a.txt", WIN)).toBe("C:\\Users\\x")
    expect(dirOf("/etc/nginx/nginx.conf", NIX)).toBe("/etc/nginx")
  })

  it("根下的一项，其所在目录是根本身而不是空串", () => {
    expect(dirOf("/etc", NIX)).toBe("/")
    expect(dirOf("C:\\Users", WIN)).toBe("C:\\")
  })

  it("不含分隔符时返回空串，交给内核决定起点", () => {
    expect(dirOf("relative", NIX)).toBe("")
    expect(dirOf("", NIX)).toBe("")
  })
})

describe("面包屑", () => {
  it("Windows：首节是盘根", () => {
    expect(crumbsOf("C:\\Users\\x", WIN)).toEqual([
      { label: "C:\\", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "x", path: "C:\\Users\\x" }
    ])
  })

  it("类 Unix：首节是斜杠", () => {
    expect(crumbsOf("/etc/nginx", NIX)).toEqual([
      { label: "/", path: "/" },
      { label: "etc", path: "/etc" },
      { label: "nginx", path: "/etc/nginx" }
    ])
  })

  it("根自身只有一节", () => {
    expect(crumbsOf("C:\\", WIN)).toEqual([{ label: "C:\\", path: "C:\\" }])
    expect(crumbsOf("/", NIX)).toEqual([{ label: "/", path: "/" }])
  })

  it("最外层没有面包屑：盘符列表本身已是最顶层", () => {
    expect(crumbsOf("", WIN)).toEqual([])
  })

  it("每一节的 path 都能直接拿去请求，逐节可回溯", () => {
    const crumbs = crumbsOf("/a/b/c", NIX)
    expect(crumbs.map(c => c.path)).toEqual(["/", "/a", "/a/b", "/a/b/c"])
  })

  it("末尾多余的分隔符不产出空节", () => {
    expect(crumbsOf("/a/b/", NIX).map(c => c.label)).toEqual(["/", "a", "b"])
    expect(crumbsOf("C:\\a\\", WIN).map(c => c.label)).toEqual(["C:\\", "a"])
  })
})
