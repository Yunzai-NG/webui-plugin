/**
 * 模块职责：`panelserver.ts` 的用例 —— 路径校验、入口形状、加载与失败隔离
 * 依赖方向：测试文件，依赖 panelserver 与 panelscan 的类型
 * 生命周期：每个用例造一个临时包目录，afterEach 删除
 * 注意事项：**真的写文件、真的 `import()`。** 这一路唯一容易错的地方是「绝对路径没转成
 *          file:// URL」，而那只在 Windows 上犯 —— 用替身替掉 import 恰好把它遮住。
 *
 *          入口文件一律用 `.mjs`：临时目录不在任何带 `"type": "module"` 的包之下，
 *          `.js` 会被 node 当成 CommonJS，于是 `export default` 是一条语法错误 ——
 *          而那条错误与本文件要验的东西毫无关系。
 *
 *          **每个用例的入口文件名都不同。** ESM 的模块缓存按 URL 记，同名文件改了内容
 *          再 import 仍是上一次那份 —— 这会让「改坏它应该失败」那类用例莫名通过。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { PanelPackage } from "./panelscan.js"
import { apiBaseOf } from "./panelscan.js"
import { checkPanelServer, isSafeRoutePath, loadPanelServer, loadPanelServers } from "./panelserver.js"

/** 用例造出的临时目录 */
let dirs: string[] = []

/** 每个用例一个不同的入口文件名，避开 ESM 模块缓存 */
let seq = 0

afterEach(async () => {
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })))
  dirs = []
})

/** 记下的日志行与注册过的路由 */
interface Recorder {
  /** 全部日志行，带级别前缀 */
  lines: string[]
  /** 注册过的路由路径 */
  routes: string[]
  /** 路径 → 处理函数 */
  handlers: Map<string, () => unknown>
  /** 包键 → 当前配置值，替 `PanelConfigStore` 的位置 */
  configs: Map<string, Record<string, unknown>>
}

/**
 * 造一个记录用的 host
 * @param rec 记录器
 * @returns host
 */
function hostOf(rec: Recorder): Parameters<typeof loadPanelServer>[0] {
  return {
    dataDir: "/tmp/webui-data",
    logger: {
      warn: msg => rec.lines.push(`warn ${msg}`),
      error: msg => rec.lines.push(`error ${msg}`),
      debug: msg => rec.lines.push(`debug ${msg}`)
    },
    route: (method, path, handler) => {
      rec.routes.push(path)
      rec.handlers.set(path, handler)
      return undefined
    },
    config: key => rec.configs.get(key) ?? {}
  }
}

/**
 * 造一个记录器
 * @returns 记录器
 */
function recorder(): Recorder {
  return { lines: [], routes: [], handlers: new Map(), configs: new Map() }
}

/**
 * 造一个带 node 侧入口的包目录
 * @param source 入口文件的内容
 * @param owner 归属
 * @returns 包
 */
async function makePackage(source: string, owner = "panels"): Promise<PanelPackage> {
  const root = await mkdtemp(join(tmpdir(), "yzng-panelserver-"))
  dirs.push(root)
  const dir = join(root, "demo")
  await mkdir(dir, { recursive: true })
  const entry = `server-${++seq}.mjs`
  await writeFile(join(dir, entry), source, "utf8")
  return { owner, name: "demo", dir, serverEntry: entry, needsInstall: false }
}

describe("isSafeRoutePath", () => {
  it("放行字母数字与 . _ - /", () => {
    expect(isSafeRoutePath("hardware")).toBe(true)
    expect(isSafeRoutePath("disk/io")).toBe(true)
    expect(isSafeRoutePath("a_b-c.d")).toBe(true)
  })

  it("**挡下 `..`** —— 那不是目录穿越而是路由穿越，一个包会悄悄接管另一个包的接口", () => {
    expect(isSafeRoutePath("../other/x")).toBe(false)
    expect(isSafeRoutePath("..")).toBe(false)
  })

  it("挡下空串与含空格、问号、冒号的路径", () => {
    for (const bad of ["", "a b", "a?b=1", "http://x", "a#b"]) {
      expect(isSafeRoutePath(bad), bad).toBe(false)
    }
  })
})

describe("checkPanelServer", () => {
  it("认默认导出里的 setup", () => {
    const checked = checkPanelServer({ default: { setup: () => undefined } })
    expect(checked.ok).toBe(true)
  })

  it("也认直接挂在模块上的 setup —— 手写 ESM 的人两种都会写", () => {
    expect(checkPanelServer({ setup: () => undefined }).ok).toBe(true)
  })

  it("缺 setup 或默认导出不是对象时给出可直接示人的原因", () => {
    const a = checkPanelServer({ default: {} })
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.reason).toContain("setup")

    const b = checkPanelServer({ default: 42 })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toContain("setup")
  })
})

describe("apiBaseOf", () => {
  it("按归属与包名拼出基地址，落在 papi 前缀之下而非静态目录的 pp", () => {
    const pkg: PanelPackage = { owner: "panels", name: "hardware", dir: "/x", needsInstall: false }
    expect(apiBaseOf(pkg)).toBe("/plugin/webui/papi/panels/hardware")
    expect(apiBaseOf({ ...pkg, name: "redis-watch" })).toBe("/plugin/webui/papi/panels/redis-watch")
  })
})

describe("loadPanelServer", () => {
  it("加载入口、调 setup，路由落在本包前缀之下", async () => {
    const rec = recorder()
    const pkg = await makePackage(`export default { setup(ctx) { ctx.route("hardware", () => ({ ok: 1 })) } }`)

    expect(await loadPanelServer(hostOf(rec), pkg)).toBe(true)
    expect(rec.routes).toEqual(["/papi/panels/demo/hardware"])
    expect(rec.handlers.get("/papi/panels/demo/hardware")?.()).toEqual({ ok: 1 })
  })

  it("受限上下文只给五项，拿不到内核的东西", async () => {
    const rec = recorder()
    const pkg = await makePackage(
      `export default { setup(ctx) { ctx.route("keys", () => Object.keys(ctx).sort()) } }`
    )

    await loadPanelServer(hostOf(rec), pkg)
    expect(rec.handlers.get("/papi/panels/demo/keys")?.()).toEqual([
      "config",
      "dataDir",
      "dir",
      "logger",
      "name",
      "route"
    ])
  })

  it("`ctx.config()` 取到的是本包的那一份，按包键取", async () => {
    const rec = recorder()
    rec.configs.set("panels/demo", { redis: { port: 6380 } })
    rec.configs.set("panels/other", { redis: { port: 1 } })
    const pkg = await makePackage(`export default { setup(ctx) { ctx.route("conf", () => ctx.config()) } }`)

    await loadPanelServer(hostOf(rec), pkg)
    expect(rec.handlers.get("/papi/panels/demo/conf")?.()).toEqual({ redis: { port: 6380 } })
  })

  it("**每次调 `config()` 都取当前值** —— 存下来的那一份不会跟着使用者的改动变", async () => {
    const rec = recorder()
    rec.configs.set("panels/demo", { port: 1 })
    // 一半在 setup 里存下来、一半每次现取，两者的差别正是本条要钉住的
    const pkg = await makePackage(
      `export default {
         setup(ctx) {
           const once = ctx.config()
           ctx.route("conf", () => ({ once, now: ctx.config() }))
         }
       }`
    )

    await loadPanelServer(hostOf(rec), pkg)
    rec.configs.set("panels/demo", { port: 2 })
    expect(rec.handlers.get("/papi/panels/demo/conf")?.()).toEqual({ once: { port: 1 }, now: { port: 2 } })
  })

  it("没声明配置的包读到空对象，而不是 undefined —— 免得每个包都先判一次", async () => {
    const rec = recorder()
    const pkg = await makePackage(`export default { setup(ctx) { ctx.route("conf", () => ctx.config()) } }`)

    await loadPanelServer(hostOf(rec), pkg)
    expect(rec.handlers.get("/papi/panels/demo/conf")?.()).toEqual({})
  })

  it("包的日志带上包名前缀，否则一堆包的日志分不出是谁的", async () => {
    const rec = recorder()
    const pkg = await makePackage(`export default { setup(ctx) { ctx.logger.warn("探测不到显卡") } }`)

    await loadPanelServer(hostOf(rec), pkg)
    expect(rec.lines.some(line => line === "warn 面板插件包 panels/demo：探测不到显卡")).toBe(true)
  })

  it("包试图注册越界路径时拒绝，且不注册任何路由", async () => {
    const rec = recorder()
    const pkg = await makePackage(`export default { setup(ctx) { ctx.route("../victim/x", () => 1) } }`)

    expect(await loadPanelServer(hostOf(rec), pkg)).toBe(true)
    expect(rec.routes).toEqual([])
    expect(rec.lines.some(line => line.includes("已拒绝"))).toBe(true)
  })

  it("入口有语法错时只记一条错并作罢，**并提到装依赖**", async () => {
    const rec = recorder()
    const pkg = await makePackage(`export default { setup( `)

    expect(await loadPanelServer(hostOf(rec), pkg)).toBe(false)
    // 最常见的失败原因是没装依赖，而报出来的却是一条 import 错误
    expect(rec.lines.some(line => line.includes("包管理器安装"))).toBe(true)
  })

  it("入口文件不存在时同样只记一条错", async () => {
    const rec = recorder()
    const pkg = await makePackage("export default { setup() {} }")

    expect(await loadPanelServer(hostOf(rec), { ...pkg, serverEntry: "missing.mjs" })).toBe(false)
    expect(rec.routes).toEqual([])
  })

  it("setup 抛错时不向上抛 —— 一个坏包不该让面板打不开", async () => {
    const rec = recorder()
    const pkg = await makePackage(`export default { setup() { throw new Error("redis 连不上") } }`)

    expect(await loadPanelServer(hostOf(rec), pkg)).toBe(false)
    expect(rec.lines.some(line => line.includes("redis 连不上"))).toBe(true)
  })

  it("未声明 node 侧入口的包直接跳过，不记任何日志", async () => {
    const rec = recorder()
    const pkg = await makePackage("export default { setup() {} }")

    expect(await loadPanelServer(hostOf(rec), { ...pkg, serverEntry: undefined })).toBe(false)
    expect(rec.lines).toEqual([])
  })
})

describe("loadPanelServers", () => {
  it("一个包失败不连坐其余，返回的是成功的那些", async () => {
    const rec = recorder()
    const good = await makePackage(`export default { setup(ctx) { ctx.route("ok", () => 1) } }`)
    const bad = await makePackage(`export default { setup() { throw new Error("坏了") } }`)
    const plain = await makePackage("export default { setup() {} }")

    const loaded = await loadPanelServers(hostOf(rec), [
      good,
      { ...bad, name: "bad" },
      { ...plain, name: "plain", serverEntry: undefined }
    ])

    expect([...loaded]).toEqual(["panels/demo"])
    expect(rec.routes).toEqual(["/papi/panels/demo/ok"])
  })
})
