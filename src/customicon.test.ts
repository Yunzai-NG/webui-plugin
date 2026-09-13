import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isImageIcon, loadImageIcon } from "./customicon.js"

const dirs: string[] = []
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6WQAAAAASUVORK5CYII=", "base64")
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yzng-icon-"))
  dirs.push(dir)
  return dir
}

describe("插件相对图片图标", () => {
  it("区分 emoji 与图片路径，基于插件根目录读取 src/logo.png", async () => {
    const dir = await root()
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src/logo.png"), png)
    expect(isImageIcon("🦊")).toBe(false)
    expect(isImageIcon("src/logo.png")).toBe(true)
    expect(await loadImageIcon(dir, "src/logo.png")).toBe(`data:image/png;base64,${png.toString("base64")}`)
    expect(await loadImageIcon(dir, "./src/logo.png")).toBe(`data:image/png;base64,${png.toString("base64")}`)
  })

  it("拒绝路径穿越、绝对路径、远端地址、编码路径和非图片扩展名", async () => {
    const dir = await root()
    for (const path of ["../outside.png", "/outside.png", "C:/outside.png", "https://example.com/a.png",
      "src\\logo.png", "%2e%2e/a.png", "src/a.png?x=1", "src/a.png#x", "package.json"]) {
      await expect(loadImageIcon(dir, path), path).rejects.toThrow()
    }
  })

  it("符号链接不能指向插件外，使用目录 junction 兼容 Windows", async () => {
    const dir = await root()
    const outside = await root()
    await writeFile(join(outside, "logo.png"), png)
    await symlink(outside, join(dir, "escape"), "junction")
    await expect(loadImageIcon(dir, "escape/logo.png")).rejects.toThrow("越出插件目录")
  })

  it("缺失、目录、空文件、超大图片均拒绝", async () => {
    const dir = await root()
    await mkdir(join(dir, "folder.png"))
    await writeFile(join(dir, "empty.png"), "")
    await writeFile(join(dir, "large.png"), Buffer.alloc(256 * 1024 + 1))
    for (const path of ["absent.png", "folder.png", "empty.png", "large.png"]) {
      await expect(loadImageIcon(dir, path)).rejects.toThrow()
    }
  })
})