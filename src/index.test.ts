/**
 * 模块职责：面板插件入口的用例
 * 依赖方向：测试文件，依赖 index.ts
 * 生命周期：一次性
 * 注意事项：**三种情形必须分别断言**：产物齐备、产物缺失、根路径已被占用。
 *          三者在内核看来的表现都是「面板打不开」，但处置方式完全不同 ——
 *          分别是可用、去构建前端、以及查另一个插件。若只测成功路径，
 *          那两条错误分支写错了也不会有人知道。
 *
 *          面板插件那一段的重点是**「清单只列已挂载的归属」**：重扫时若发现一个新装
 *          插件的 `panel/`，它的静态目录此刻并不存在，列进清单只会让浏览器 import 到
 *          404，而那会被显示成「这个组件坏了」。这条断言查的是一处不会报错的缺陷。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import plugin, {
  PANEL_STORE_ENDPOINT,
  mountPanelStore,
  PANELS_ENDPOINT,
  PANEL_CONFIG_ENDPOINT,
  mountPanel,
  mountPanelPlugins,
  webDirOf,
  type PanelHost,
  type PanelRequest,
} from "./index.js"
import type { PanelEntry } from "./panelscan.js"

/** 用例造出的临时目录，afterEach 统一清理 */
let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })))
  dirs = []
})

/**
 * 造一个临时目录
 * @returns 目录绝对路径
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yzng-webui-"))
  dirs.push(dir)
  return dir
}

/** 一次静态挂载的录制 */
interface StaticCall {
  /** 相对 scope 的 URL 路径 */
  urlPath: string
  /** 本地目录 */
  dir: string
}

/** 录制到的调用 */
interface Recorded {
  /** 上下文替身 */
  ctx: PanelHost
  /** panel() 收到的目录 */
  mounted: string[]
  /** static() 收到的挂载 */
  statics: StaticCall[]
  /** route() 注册的路径 → 处理函数 */
  routes: Map<string, (req: PanelRequest) => unknown>
  /** warn 的内容 */
  warns: string[]
  /** error 的内容 */
  errors: string[]
}

/** 造上下文替身的参数 */
interface RecordingOptions {
  /** panel() 的行为，缺省什么都不做 */
  onPanel?: (dir: string) => void
  /** static() 的行为，缺省什么都不做；抛错即模拟「该目录挂不上」 */
  onStatic?: (urlPath: string, dir: string) => void
  /** 本插件数据目录，缺省一个不存在的路径 */
  dataDir?: string
  /**
   * 内核配置目录，缺省一个不存在的路径
   *
   * 缺省即「读不到内核配置」，此时按不用镜像、非只读处理（见 `coreconfig.ts`）——
   * 那正是绝大多数用例要的前提。要验只读模式的用例自己造一份 yaml 传进来。
   */
  configDir?: string
  /** 临时目录，缺省一个不存在的路径 */
  tempDir?: string
  /** 本插件的配置快照，缺省空对象（等同于「未声明 schema」） */
  config?: unknown
}

/**
 * 造一份录制型上下文
 * @param opts 见 `RecordingOptions`
 * @returns 上下文与录制结果
 */
function recording(opts: RecordingOptions = {}): Recorded {
  const mounted: string[] = []
  const statics: StaticCall[] = []
  const routes = new Map<string, (req: PanelRequest) => unknown>()
  const warns: string[] = []
  const errors: string[] = []
  const ctx: PanelHost = {
    logger: {
      warn: m => void warns.push(m),
      error: m => void errors.push(m),
      debug: () => undefined
    },
    dataDir: opts.dataDir ?? join(tmpdir(), "yzng-webui-absent"),
    panel: dir => {
      mounted.push(dir)
      opts.onPanel?.(dir)
      return () => undefined
    },
    static: (urlPath, dir) => {
      opts.onStatic?.(urlPath, dir)
      statics.push({ urlPath, dir })
      return () => undefined
    },
    route: (method, path, handler) => {
      // 键带上方法：商店的 `GET panelstore` 与 `POST panelstore/install` 之外，
      // 还有 `DELETE panelstore/:name` 与 `POST panelstore/:name/update` —— 只按路径
      // 记会让后注册的顶掉前一个，而顶掉之后用例仍能跑，只是验的不是它以为的那条
      routes.set(`${method} ${path}`, handler)
      return () => undefined
    },
    http: {
      get: async () => {
        throw new Error("用例未提供 http.get")
      },
      buffer: async () => {
        throw new Error("用例未提供 http.buffer")
      }
    } as unknown as PanelHost["http"],
    version: "0.1.0",
    app: {
      paths: {
        config: opts.configDir ?? join(tmpdir(), "yzng-webui-absent-config"),
        temp: opts.tempDir ?? join(tmpdir(), "yzng-webui-absent-temp")
      }
    },
    config: { get: () => opts.config ?? {} }
  }
  return { ctx, mounted, statics, routes, warns, errors }
}

describe("插件声明", () => {
  it("插件名为 webui，与配置文件名和日志作用域一致", () => {
    expect(plugin.name).toBe("webui")
  })
})

describe("webDirOf", () => {
  it("产物目录与入口同级，名为 web", () => {
    expect(webDirOf(join("/opt", "plugin", "dist"))).toBe(join("/opt", "plugin", "dist", "web"))
  })
})

describe("mountPanel", () => {
  it("产物齐备时接管根路径", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "index.html"), "<html>面板</html>", "utf8")
    const r = recording()

    expect(mountPanel(r.ctx, dir)).toBe(true)
    expect(r.mounted).toEqual([dir])
    expect(r.warns).toEqual([])
  })

  it("产物缺失时不抛错，且提示里带上构建命令", async () => {
    const dir = await tempDir()
    const r = recording()

    expect(mountPanel(r.ctx, dir)).toBe(false)
    expect(r.mounted).toEqual([])
    // 断言提示中含可直接照做的命令：只说"未找到产物"无法让使用者知道下一步做什么
    expect(r.warns[0]).toContain("build:web")
  })

  it("根路径已被占用时只记 error，不向上抛", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "index.html"), "<html>面板</html>", "utf8")
    const r = recording({
      onPanel: () => {
        throw new Error("站点根路径已被 plugin:other 占用")
      }
    })

    expect(mountPanel(r.ctx, dir)).toBe(false)
    expect(r.errors[0]).toContain("plugin:other")
  })
})

/** 不带路径参数与请求体的一次请求，读端点用 */
const NO_REQ: PanelRequest = { params: {}, body: undefined }

/**
 * 取清单端点的返回
 * @param r 录制结果
 * @returns 清单项
 */
async function fetchManifest(r: Recorded): Promise<PanelEntry[]> {
  const handler = r.routes.get(`GET /${PANELS_ENDPOINT}`)
  if (handler === undefined) throw new Error("清单端点未注册")
  const body = (await handler(NO_REQ)) as { items: PanelEntry[] }
  return body.items
}

/**
 * 调一次配置写入端点
 * @param r 录制结果
 * @param name 包名
 * @param body 请求体
 * @returns 响应体
 */
async function putConfig(r: Recorded, name: string, body: unknown): Promise<unknown> {
  const handler = r.routes.get(`PUT /${PANEL_CONFIG_ENDPOINT}/:owner/:name`)
  if (handler === undefined) throw new Error("配置写入端点未注册")
  return handler({ params: { owner: "panels", name }, body })
}

/**
 * 调一次恢复默认值端点
 * @param r 录制结果
 * @param name 包名
 * @returns 响应体
 */
async function resetConfig(r: Recorded, name: string): Promise<unknown> {
  const handler = r.routes.get(`POST /${PANEL_CONFIG_ENDPOINT}/:owner/:name/reset`)
  if (handler === undefined) throw new Error("恢复默认值端点未注册")
  return handler({ params: { owner: "panels", name }, body: undefined })
}

/**
 * 造一个当 webui 安装目录用的临时目录，并在其下备好 `plugins/`
 * @returns 安装目录绝对路径
 */
async function webuiRootWithPanels(): Promise<string> {
  const root = await tempDir()
  await mkdir(join(root, "plugins"), { recursive: true })
  return root
}

describe("mountPanelPlugins", () => {
  it("目录恒被挂载，即使它此刻不存在", async () => {
    const root = await tempDir()
    const r = recording({})

    const mounted = await mountPanelPlugins(r.ctx, root)

    // 目录不存在也要挂：使用者放进第一个文件后只需刷新页面，不必重载插件
    expect(mounted.has("panels")).toBe(true)
    expect(r.statics).toEqual([{ urlPath: "pp/panels", dir: join(root, "plugins") }])
  })

  it("主路的单文件进清单且记作 single", async () => {
    const root = await webuiRootWithPanels()
    await writeFile(join(root, "plugins", "clock.js"), "export default {}", "utf8")
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)

    expect(await fetchManifest(r)).toContainEqual({
      owner: "panels",
      file: "clock.js",
      url: "/plugin/webui/pp/panels/clock.js",
      kind: "single"
    })
  })

  it("主路的子目录记作 multi，且带上它 package.json 里的自报信息", async () => {
    const root = await webuiRootWithPanels()
    const sub = join(root, "plugins", "weather")
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, "index.js"), "export default {}", "utf8")
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({
        version: "1.2.0",
        description: "天气",
        repository: "https://example.com/weather",
        author: "某人"
      }),
      "utf8"
    )
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)

    expect(await fetchManifest(r)).toContainEqual({
      owner: "panels",
      file: "weather/index.js",
      url: "/plugin/webui/pp/panels/weather/index.js",
      kind: "multi",
      meta: {
        version: "1.2.0",
        description: "天气",
        repository: "https://example.com/weather",
        author: "某人"
      }
    })
  })

  it("多文件缺 package.json 时仍进清单，由浏览器侧画占位格", async () => {
    const root = await webuiRootWithPanels()
    const sub = join(root, "plugins", "naked")
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, "index.js"), "export default {}", "utf8")
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)

    // 在 node 侧丢掉它只留一条日志，等于什么都没说；那格红字才是使用者真会看到的
    const items = await fetchManifest(r)
    expect(items.map(item => item.file)).toContain("naked/index.js")
    expect(items.find(item => item.file === "naked/index.js")?.meta).toBeUndefined()
  })

  it("子目录缺 index.js 时记一条警告 —— 静默跳过等于「装了却什么都没有」", async () => {
    const root = await webuiRootWithPanels()
    await mkdir(join(root, "plugins", "wrong-level"), { recursive: true })
    const r = recording({})

    await mountPanelPlugins(r.ctx, root)

    expect(r.warns[0]).toContain("index.js")
    expect(await fetchManifest(r)).toEqual([])
  })

  it("目录挂不上时清单为空 —— 列进去只会让浏览器 import 到 404", async () => {
    const root = await webuiRootWithPanels()
    await writeFile(join(root, "plugins", "a.js"), "export default {}", "utf8")
    const r = recording({
      onStatic: urlPath => {
        if (urlPath === "pp/panels") throw new Error("该模式已注册")
      }
    })

    const mounted = await mountPanelPlugins(r.ctx, root)

    expect(mounted.has("panels")).toBe(false)
    expect(r.errors[0]).toContain("该模式已注册")
    expect(await fetchManifest(r)).toEqual([])
  })

  it("清单每次被请求时重扫，故新放进去的文件刷新页面即生效", async () => {
    const root = await webuiRootWithPanels()
    const r = recording({})
    await mountPanelPlugins(r.ctx, root)

    expect(await fetchManifest(r)).toEqual([])

    // 挂载之后才放进去的文件
    await writeFile(join(root, "plugins", "late.js"), "export default {}", "utf8")

    expect(await fetchManifest(r)).toEqual([
      { owner: "panels", file: "late.js", url: "/plugin/webui/pp/panels/late.js", kind: "single" }
    ])
  })

  it("重扫不再重复告警：启动时已说过一遍", async () => {
    const root = await webuiRootWithPanels()
    await writeFile(join(root, "plugins", "widget.ts"), "export default {}", "utf8")
    const r = recording({})

    await mountPanelPlugins(r.ctx, root)
    expect(r.warns.length).toBe(1)

    await fetchManifest(r)
    await fetchManifest(r)
    expect(r.warns.length).toBe(1)
  })

  it("**声明了 node 侧入口的包，清单里带上它的接口基地址**", async () => {
    const root = await webuiRootWithPanels()
    const sub = join(root, "plugins", "hardware")
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, "index.js"), "export default []", "utf8")
    await writeFile(join(sub, "server.mjs"), "export default { setup(ctx) { ctx.route('x', () => 1) } }", "utf8")
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({
        version: "0.1.0",
        description: "硬件",
        repository: "https://github.com/Yunzai-NG/hardware-plugin",
        webuiPanel: { server: "server.mjs" }
      }),
      "utf8"
    )
    const r = recording({})

    await mountPanelPlugins(r.ctx, root)

    const item = (await fetchManifest(r)).find(entry => entry.file === "hardware/index.js")
    expect(item?.api).toBe("/plugin/webui/papi/panels/hardware")
    // node 侧真的被加载了：它注册的那条路由落在本包的前缀之下
    expect(r.routes.has("GET /papi/panels/hardware/x")).toBe(true)
  })

  it("node 侧没加载成功的包不给 api 地址 —— 留着就是一条稳定 404", async () => {
    const root = await webuiRootWithPanels()
    const sub = join(root, "plugins", "broken")
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, "index.js"), "export default []", "utf8")
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({
        version: "0.1.0",
        description: "坏的",
        repository: "https://github.com/a/b",
        webuiPanel: { server: "missing.mjs" }
      }),
      "utf8"
    )
    const r = recording({})

    await mountPanelPlugins(r.ctx, root)

    const item = (await fetchManifest(r)).find(entry => entry.file === "broken/index.js")
    expect(item).toBeDefined()
    expect(item?.api).toBeUndefined()
    expect(r.errors.some(line => line.includes("broken"))).toBe(true)
  })
})

/**
 * 造一个带配置声明的包
 * @param root webui 安装目录
 * @param name 包名
 * @param over 覆盖 webuiPanel 里的字段
 * @returns 包目录
 */
async function seedConfigurable(
  root: string,
  name = "watch",
  over: Record<string, unknown> = {}
): Promise<string> {
  const sub = join(root, "plugins", name)
  await mkdir(sub, { recursive: true })
  await writeFile(join(sub, "index.js"), "export default []", "utf8")
  await writeFile(
    join(sub, "package.json"),
    JSON.stringify({
      version: "0.1.0",
      description: "看",
      repository: "https://github.com/a/w",
      webuiPanel: {
        config: {
          type: "object",
          properties: {
            host: { type: "string", default: "127.0.0.1" },
            port: { type: "number", default: 6379 }
          }
        },
        ...over
      }
    }),
    "utf8"
  )
  return sub
}

describe("面板插件包的配置", () => {
  it("**声明与值随清单一并送出** —— 分两次请求就有「schema 是新的、值是旧的」那半拍窗口", async () => {
    const root = await webuiRootWithPanels()
    await seedConfigurable(root)
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)

    const item = (await fetchManifest(r)).find(entry => entry.file === "watch/index.js")
    expect(item?.config?.schema.properties?.port).toEqual({ type: "number", default: 6379 })
    // 还没配置过，故值就是声明里的默认值 —— **由 node 侧填好**，浏览器不再算一遍
    expect(item?.config?.value).toEqual({ host: "127.0.0.1", port: 6379 })
  })

  it("没声明配置的包，清单里没有这一项", async () => {
    const root = await webuiRootWithPanels()
    await writeFile(join(root, "plugins", "clock.js"), "export default {}", "utf8")
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)

    expect((await fetchManifest(r))[0]?.config).toBeUndefined()
  })

  it("**声明写坏时清单里带上原因** —— 那是「配置按钮没出现」唯一的去处", async () => {
    const root = await webuiRootWithPanels()
    const sub = join(root, "plugins", "bad")
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, "index.js"), "export default []", "utf8")
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({
        version: "0.1.0",
        description: "坏",
        repository: "https://github.com/a/b",
        webuiPanel: { config: { type: "object", properties: { port: { type: "int" } } } }
      }),
      "utf8"
    )
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)

    const item = (await fetchManifest(r))[0]
    expect(item?.config).toBeUndefined()
    expect(item?.configError).toContain("配置字段 port")
  })

  it("存进去的值下一次取清单即可见，且落在数据目录而非包目录里", async () => {
    const root = await webuiRootWithPanels()
    const sub = await seedConfigurable(root)
    const dataDir = await tempDir()
    const r = recording({ dataDir })

    await mountPanelPlugins(r.ctx, root)
    expect(await putConfig(r, "watch", { host: "10.0.0.8", port: 6380 })).toEqual({
      value: { host: "10.0.0.8", port: 6380 },
      issues: []
    })

    const item = (await fetchManifest(r)).find(entry => entry.file === "watch/index.js")
    expect(item?.config?.value).toEqual({ host: "10.0.0.8", port: 6380 })
    // 包目录会被「更新 webui」整目录替换，故配置一个字节都不该落在那里
    await expect(readFile(join(sub, "config.json"), "utf8")).rejects.toThrow()
    expect(JSON.parse(await readFile(join(dataDir, "panelconfig", "panels", "watch.json"), "utf8"))).toEqual({
      host: "10.0.0.8",
      port: 6380
    })
  })

  it("**类型不符时 400，且 issues 逐字段送出**（表单据此标注），文件不动", async () => {
    const root = await webuiRootWithPanels()
    await seedConfigurable(root)
    const dataDir = await tempDir()
    const r = recording({ dataDir })

    await mountPanelPlugins(r.ctx, root)
    const res = (await putConfig(r, "watch", { port: "6380" })) as {
      status: number
      body: { error: string; issues: Array<{ path: string; severity: string }> }
    }

    expect(res.status).toBe(400)
    expect(res.body.issues).toEqual([expect.objectContaining({ path: "port", severity: "error" })])
    await expect(readFile(join(dataDir, "panelconfig", "panels", "watch.json"), "utf8")).rejects.toThrow()
  })

  it("恢复默认值把文件删掉，清单随之回到默认", async () => {
    const root = await webuiRootWithPanels()
    await seedConfigurable(root)
    const dataDir = await tempDir()
    const r = recording({ dataDir })

    await mountPanelPlugins(r.ctx, root)
    await putConfig(r, "watch", { host: "10.0.0.8", port: 6380 })
    expect(await resetConfig(r, "watch")).toEqual({ value: { host: "127.0.0.1", port: 6379 } })

    const item = (await fetchManifest(r)).find(entry => entry.file === "watch/index.js")
    expect(item?.config?.value).toEqual({ host: "127.0.0.1", port: 6379 })
    await expect(readFile(join(dataDir, "panelconfig", "panels", "watch.json"), "utf8")).rejects.toThrow()
  })

  it("不存在的包给 404，而不是造一份空配置出来", async () => {
    const root = await webuiRootWithPanels()
    await seedConfigurable(root)
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)
    const res = (await putConfig(r, "absent", {})) as { status: number }
    expect(res.status).toBe(404)
  })

  it("**写路由每次重扫**，故启动之后才放进去的包同样改得动", async () => {
    const root = await webuiRootWithPanels()
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)
    await seedConfigurable(root, "later")

    expect(await putConfig(r, "later", { host: "10.0.0.1" })).toEqual({
      value: { host: "10.0.0.1", port: 6379 },
      issues: []
    })
  })

  it("**包的 node 侧读到的是同一份值**，且改完不必重启 —— 那两半靠这一条对齐", async () => {
    const root = await webuiRootWithPanels()
    const sub = await seedConfigurable(root, "watch", { server: "server.mjs" })
    await writeFile(
      join(sub, "server.mjs"),
      "export default { setup(ctx) { ctx.route('conf', () => ctx.config()) } }",
      "utf8"
    )
    const r = recording({ dataDir: await tempDir() })

    await mountPanelPlugins(r.ctx, root)
    const handler = r.routes.get("GET /papi/panels/watch/conf")
    expect(handler?.(NO_REQ)).toEqual({ host: "127.0.0.1", port: 6379 })

    await putConfig(r, "watch", { host: "10.0.0.8", port: 6380 })
    expect(handler?.(NO_REQ)).toEqual({ host: "10.0.0.8", port: 6380 })
  })

  /*
   * 只读模式下这两条写路由要拒
   *
   * 它们起初不受只读模式约束：内核的 `requireWritable()` 只拦 `/api` 之下的写请求，
   * 而这两条落在 webui 自己的 scope 里。当时把这一条记成「要给内核加一处对外可见的只读
   * 标志」，实则 `server.readonly` 就在内核配置文件里，webui 自己读得到。
   */
  it("**只读模式下配置写入 403**，且文案与内核那条一致", async () => {
    const root = await webuiRootWithPanels()
    await seedConfigurable(root)
    const configDir = await tempDir()
    await writeFile(join(configDir, "yunzai.yaml"), "server:\n  readonly: true\n", "utf8")
    const r = recording({ dataDir: await tempDir(), configDir })

    await mountPanelPlugins(r.ctx, root)
    const res = (await putConfig(r, "watch", { host: "10.0.0.8" })) as { status: number; body: { error: string } }
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("只读模式（配置项 server.readonly 为 true）")
  })

  it("只读模式下恢复默认值同样 403 —— 它一样会删文件", async () => {
    const root = await webuiRootWithPanels()
    await seedConfigurable(root)
    const configDir = await tempDir()
    await writeFile(join(configDir, "yunzai.yaml"), "server:\n  readonly: true\n", "utf8")
    const r = recording({ dataDir: await tempDir(), configDir })

    await mountPanelPlugins(r.ctx, root)
    expect((await resetConfig(r, "watch")) as { status: number }).toMatchObject({ status: 403 })
  })

  it("只读模式下**清单照常可读** —— 只读拦的是写，不是看", async () => {
    const root = await webuiRootWithPanels()
    await seedConfigurable(root)
    const configDir = await tempDir()
    await writeFile(join(configDir, "yunzai.yaml"), "server:\n  readonly: true\n", "utf8")
    const r = recording({ dataDir: await tempDir(), configDir })

    await mountPanelPlugins(r.ctx, root)
    expect((await fetchManifest(r)).length).toBeGreaterThan(0)
  })
})

describe("mountPanelStore", () => {
  /**
   * 挂一次商店，并给一份索引
   * @param opts 额外的 ctx 参数
   * @returns 录制结果与落点
   */
  async function mounted(opts: RecordingOptions = {}): Promise<{ r: Recorded; root: string }> {
    const root = await webuiRootWithPanels()
    const r = recording({ dataDir: await tempDir(), tempDir: await tempDir(), ...opts })
    mountPanelStore(r.ctx, root)
    return { r, root }
  }

  it("五条路由都注册了，且方法各就各位", async () => {
    const { r } = await mounted()
    expect([...r.routes.keys()].filter(key => key.includes(PANEL_STORE_ENDPOINT)).sort()).toEqual([
      `DELETE /${PANEL_STORE_ENDPOINT}/:name`,
      `GET /${PANEL_STORE_ENDPOINT}`,
      `POST /${PANEL_STORE_ENDPOINT}/:name/update`,
      `POST /${PANEL_STORE_ENDPOINT}/install`,
      `POST /${PANEL_STORE_ENDPOINT}/refresh`
    ])
  })

  it("索引取不到时 GET 仍给一份快照（记在 sources 里），而不是 500", async () => {
    const { r } = await mounted()
    const handler = r.routes.get(`GET /${PANEL_STORE_ENDPOINT}`)
    const snap = (await handler?.(NO_REQ)) as { panels: unknown[]; sources: Array<{ ok: boolean }> }
    expect(snap.panels).toEqual([])
    expect(snap.sources[0]?.ok).toBe(false)
  })

  it("装一个索引里没有的名字给 400 并把原话带上 —— 500 加一句「内部错误」帮不到任何人", async () => {
    const { r } = await mounted()
    const handler = r.routes.get(`POST /${PANEL_STORE_ENDPOINT}/install`)
    const res = (await handler?.({ params: {}, body: { name: "nothere" } })) as {
      status: number
      body: { error: string }
    }
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("nothere")
  })

  it("删一个不存在的目录给 404", async () => {
    const { r } = await mounted()
    const handler = r.routes.get(`DELETE /${PANEL_STORE_ENDPOINT}/:name`)
    const res = (await handler?.({ params: { name: "absent" }, body: undefined })) as { status: number }
    expect(res.status).toBe(404)
  })

  it("**只读模式下四条写路由一律 403**，而列出照常", async () => {
    const configDir = await tempDir()
    await writeFile(join(configDir, "yunzai.yaml"), "server:\n  readonly: true\n", "utf8")
    const { r } = await mounted({ configDir })

    const install = r.routes.get(`POST /${PANEL_STORE_ENDPOINT}/install`)
    const update = r.routes.get(`POST /${PANEL_STORE_ENDPOINT}/:name/update`)
    const del = r.routes.get(`DELETE /${PANEL_STORE_ENDPOINT}/:name`)
    for (const [handler, req] of [
      [install, { params: {}, body: { name: "hardware" } }],
      [update, { params: { name: "hardware" }, body: {} }],
      [del, { params: { name: "hardware" }, body: undefined }]
    ] as const) {
      expect((await handler?.(req)) as { status: number }).toMatchObject({ status: 403 })
    }

    const list = r.routes.get(`GET /${PANEL_STORE_ENDPOINT}`)
    expect((await list?.(NO_REQ)) as { readonly: boolean }).toMatchObject({ readonly: true })
  })

  it("**名字不合法时拒绝**，不做纠正后重试", async () => {
    const { r } = await mounted()
    const handler = r.routes.get(`DELETE /${PANEL_STORE_ENDPOINT}/:name`)
    const res = (await handler?.({ params: { name: "../../etc" }, body: undefined })) as {
      status: number
      body: { error: string }
    }
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/名不合法/)
  })
})
