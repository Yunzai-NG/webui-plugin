/**
 * 模块职责：面板插件文件取用的边界 —— 交出浏览器要的，挡住 node 侧、依赖清单与越界链接
 * 依赖方向：测试文件，依赖 panelfiles.ts
 * 生命周期：每个用例一个临时 plugins 目录
 * 注意事项：符号链接用例在建不了链接的环境（Windows 无开发者模式时建文件链接要权限）里跳过
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SVG_CSP, readPanelFile } from "./panelfiles.js"

describe("readPanelFile", () => {
  let root: string
  let outside: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-panelfiles-"))
    outside = await mkdtemp(join(tmpdir(), "yzng-panelfiles-out-"))
    const pkg = join(root, "demo")
    await mkdir(join(pkg, "server"), { recursive: true })
    await mkdir(join(pkg, "widgets"), { recursive: true })
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "demo", webuiPanel: { server: "server/index.js" } }), "utf8")
    await writeFile(join(pkg, "index.js"), "export default {}", "utf8")
    await writeFile(join(pkg, "widgets", "a.js"), "1", "utf8")
    await writeFile(join(pkg, "server", "index.js"), "// node 侧", "utf8")
    await writeFile(join(pkg, "server", "secret.json"), "{}", "utf8")
    await writeFile(join(pkg, "icon.svg"), "<svg/>", "utf8")
    await writeFile(join(root, "single.js"), "1", "utf8")
    await writeFile(join(outside, "leak.js"), "外面的", "utf8")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it("浏览器侧文件照常交出", async () => {
    for (const file of ["demo/index.js", "demo/widgets/a.js", "single.js"]) {
      expect([file, (await readPanelFile(root, file)).status]).toEqual([file, 200])
    }
  })

  it("node 侧入口所在的子目录与 package.json 不交出", async () => {
    for (const file of ["demo/server/index.js", "demo/server/secret.json", "demo/package.json"]) {
      expect([file, (await readPanelFile(root, file)).status]).toEqual([file, 404])
    }
  })

  it("SVG 带 sandbox 的 CSP：直接打开时脚本不跑", async () => {
    const got = await readPanelFile(root, "demo/icon.svg")
    expect(got.status).toBe(200)
    if (got.status === 200) expect(got.csp).toBe(SVG_CSP)
  })

  it("包内指向包外的链接按真实路径判越界", async ctx => {
    // 用目录 junction：Windows 上它不要权限，文件链接要
    try {
      await symlink(outside, join(root, "demo", "widgets", "out"), "junction")
    } catch {
      ctx.skip()
    }
    expect((await readPanelFile(root, "demo/widgets/out/leak.js")).status).toBe(404)
  })

  it("包目录本身是链接（开发时 junction 进来）照常可取", async ctx => {
    const linked = join(outside, "linked")
    await mkdir(linked)
    await writeFile(join(linked, "index.js"), "1", "utf8")
    try {
      await symlink(linked, join(root, "linked"), "junction")
    } catch {
      ctx.skip()
    }
    expect((await readPanelFile(root, "linked/index.js")).status).toBe(200)
  })
})
