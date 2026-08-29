/**
 * 面板插件商店的用例
 *
 * **重点在三处「错了仍能得到对结果」的地方**，其余是形状校验：
 *
 *   1. **就地拉取的命令序列。** stash 必须先于 reset —— 次序反了同样能得到一个内容正确的
 *      目录，直到某天吃掉使用者未提交的改动。真网络在这里测不出东西：一次真实的拉取只
 *      告诉你「最后目录对了」。故 `git` 可注入，用例逐条钉住实际下发的参数。
 *   2. **fetch 的地址每次现算。** 镜像前缀是可改的配置项，沿用目录里的 origin 会让换过
 *      镜像的人永远更新失败，且错误指向一个他早已不用的地址。
 *   3. **顶层键的双向防线。** 只认 `{panels:[...]}`；顶层数组与 `{plugins:[...]}` 都要拒，
 *      且拒的话要说得出「你填的是内核那份」。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  PanelStore,
  parsePanelEntry,
  parsePanelIndex,
  type PanelStoreDeps,
  type PanelStoreEntry
} from "./panelstore.js"

/** 用完即删的临时目录 */
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * 造一个临时目录
 * @returns 目录绝对路径
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yzng-store-"))
  dirs.push(dir)
  return dir
}

/** 一条 git 调用的录制 */
interface GitCall {
  /** 命令参数 */
  args: string[]
  /** 工作目录 */
  cwd: string
}

/** 一份最小可用的索引条目 */
const HARDWARE = {
  name: "hardware",
  title: "硬件信息",
  description: "十枚组件",
  version: "0.4.0",
  official: true,
  tags: ["监控"],
  install: { type: "git", url: "https://github.com/Yunzai-NG/hardware-plugin", branch: "main" }
}

/** 造商店替身的参数 */
interface StoreOptions {
  /** 索引文档，缺省一份只含 hardware 的 */
  index?: unknown
  /** 落点目录 */
  panelsDir: string
  /** 临时目录 */
  tempDir: string
  /** 缓存文件 */
  cacheFile: string
  /** 内核那两项，缺省不用镜像、非只读 */
  core?: { mirror: string; readonly: boolean }
  /** webui 版本，缺省 0.1.0 */
  webuiVersion?: string
  /** git 的行为；缺省在 clone 时造出一个合格的包 */
  git?: (args: readonly string[], cwd: string) => Promise<string>
  /** 包管理器的行为；缺省成功并报 pnpm */
  install?: (dir: string) => Promise<string>
}

/** 录制到的调用 */
interface StoreRecorded {
  /** 商店实例 */
  store: PanelStore
  /** git 收到的调用，顺序即下发顺序 */
  gits: GitCall[]
  /** 包管理器被调用的目录 */
  installs: string[]
  /** warn 的内容 */
  warns: string[]
  /** error 的内容 */
  errors: string[]
}

/**
 * 造一份录制型商店
 * @param opts 见 `StoreOptions`
 * @returns 商店与录制结果
 */
function recording(opts: StoreOptions): StoreRecorded {
  const gits: GitCall[] = []
  const installs: string[] = []
  const warns: string[] = []
  const errors: string[] = []

  const deps: PanelStoreDeps = {
    http: {
      get: async () => opts.index ?? { panels: [HARDWARE] },
      buffer: async () => {
        throw new Error("用例未提供 buffer")
      }
    } as unknown as PanelStoreDeps["http"],
    logger: {
      warn: m => void warns.push(m),
      error: m => void errors.push(m),
      debug: () => undefined
    },
    panelsDir: opts.panelsDir,
    tempDir: opts.tempDir,
    cacheFile: opts.cacheFile,
    settings: () => ({ sources: ["https://example.invalid/webui_index.json"], cacheTtl: 3600_000, timeout: 1000 }),
    core: async () => opts.core ?? { mirror: "", readonly: false },
    webuiVersion: opts.webuiVersion ?? "0.1.0",
    git: async (args, cwd) => {
      gits.push({ args: [...args], cwd })
      if (opts.git !== undefined) return opts.git(args, cwd)
      // 缺省行为：clone 时在目标位置造出一个合格的包，其余命令给空输出
      if (args[0] === "clone") {
        const dest = args[args.length - 1] ?? ""
        await mkdir(dest, { recursive: true })
        await writeFile(join(dest, "package.json"), JSON.stringify({ name: "hardware", version: "0.4.0" }), "utf8")
        await writeFile(join(dest, "index.js"), "export const meta = {}", "utf8")
      }
      if (args[0] === "rev-parse") return "abc1234\n"
      return ""
    },
    install: async dir => {
      installs.push(dir)
      return opts.install === undefined ? "pnpm" : opts.install(dir)
    }
  }

  return { store: new PanelStore(deps), gits, installs, warns, errors }
}

/**
 * 造一份齐备的商店替身，三个目录都是新建的临时目录
 * @param opts 额外参数
 * @returns 商店、录制结果与落点目录
 */
async function freshStore(
  opts: Partial<StoreOptions> = {}
): Promise<StoreRecorded & { panelsDir: string; cacheFile: string }> {
  const panels = await tempDir()
  const temp = await tempDir()
  const cacheDir = await tempDir()
  const cacheFile = join(cacheDir, "panelstore-cache.json")
  const r = recording({ ...opts, panelsDir: panels, tempDir: temp, cacheFile })
  return { ...r, panelsDir: panels, cacheFile }
}

describe("parsePanelEntry", () => {
  it("三项必需齐备时给出条目", () => {
    const entry = parsePanelEntry(HARDWARE, "src")
    expect(entry?.name).toBe("hardware")
    expect(entry?.install.type).toBe("git")
    expect(entry?.source).toBe("src")
  })

  it("缺 install 的整条丢弃 —— 索引写错该表现为「不出现在列表里」，不是一个装不上的条目", () => {
    expect(parsePanelEntry({ name: "x", title: "X" }, "src")).toBeUndefined()
  })

  it("install.url 不是 http(s) 的整条丢弃", () => {
    expect(parsePanelEntry({ ...HARDWARE, install: { type: "git", url: "file:///etc" } }, "src")).toBeUndefined()
  })

  it("install.type 非 git / tarball 的整条丢弃", () => {
    expect(parsePanelEntry({ ...HARDWARE, install: { type: "svn", url: "https://x/y" } }, "src")).toBeUndefined()
  })

  it.each(["../evil", ".hidden", "node_modules", "有中文", "a/b"])("名字 %s 不合法，整条丢弃", name => {
    expect(parsePanelEntry({ ...HARDWARE, name }, "src")).toBeUndefined()
  })

  it("title 缺失时退回 name，description 缺失时给空串", () => {
    const entry = parsePanelEntry({ name: "x", install: HARDWARE.install }, "src")
    expect(entry?.title).toBe("x")
    expect(entry?.description).toBe("")
  })

  it("official 只认确凿的 true —— 字符串 \"true\" 算社区插件", () => {
    expect(parsePanelEntry({ ...HARDWARE, official: "true" }, "src")?.official).toBe(false)
  })

  it("minWebui 取得到；**不认 minCore**（那是内核那份索引的字段）", () => {
    expect(parsePanelEntry({ ...HARDWARE, minWebui: "0.2.0" }, "src")?.minWebui).toBe("0.2.0")
    const wrong = parsePanelEntry({ ...HARDWARE, minCore: "9.9.9" }, "src")
    expect(wrong?.minWebui).toBeUndefined()
  })

  it("widgets 填错类型时**只丢这一项**，不作废整条 —— 它不影响装不装得上", () => {
    const entry = parsePanelEntry({ ...HARDWARE, widgets: "ten" }, "src")
    expect(entry?.name).toBe("hardware")
    expect(entry?.widgets).toBeUndefined()
  })

  it("widgets 为负数或小数时同样只丢这一项", () => {
    expect(parsePanelEntry({ ...HARDWARE, widgets: -1 }, "src")?.widgets).toBeUndefined()
    expect(parsePanelEntry({ ...HARDWARE, widgets: 1.5 }, "src")?.widgets).toBeUndefined()
  })

  it("server 与 deps 只认确凿的 true", () => {
    const entry = parsePanelEntry({ ...HARDWARE, server: "yes", deps: 1 }, "src")
    expect(entry?.server).toBeUndefined()
    expect(entry?.deps).toBeUndefined()
  })

  it("install.path 被忽略而非报错 —— CI 的校验脚本拦作者，运行期不该因此少一个条目", () => {
    const entry = parsePanelEntry({ ...HARDWARE, install: { ...HARDWARE.install, path: "sub" } }, "src")
    expect(entry?.name).toBe("hardware")
    expect("path" in (entry?.install ?? {})).toBe(false)
  })
})

describe("parsePanelIndex", () => {
  it("认 { panels: [...] }", () => {
    expect(parsePanelIndex({ panels: [HARDWARE] }, "src")).toHaveLength(1)
  })

  it("**拒顶层数组** —— 放开它就把「两份索引互不相认」这道防线拆掉一半", () => {
    expect(() => parsePanelIndex([HARDWARE], "src")).toThrow(/顶层是数组/)
  })

  it("拒 { plugins: [...] } 并说出「那是内核那份，填错了地方」", () => {
    expect(() => parsePanelIndex({ plugins: [HARDWARE] }, "src")).toThrow(/内核插件市场的索引，填错了地方/)
  })

  it("既非数组也无 panels 时说「没有 panels 数组」", () => {
    expect(() => parsePanelIndex({ items: [] }, "src")).toThrow(/没有 panels 数组/)
  })

  it("不合法的条目逐条丢弃，其余照常生效", () => {
    const list = parsePanelIndex({ panels: [HARDWARE, { name: "bad" }, { ...HARDWARE, name: "other" }] }, "src")
    expect(list.map(item => item.name)).toEqual(["hardware", "other"])
  })
})

describe("list", () => {
  it("未安装时 installed 为假、updatable 为假", async () => {
    const r = await freshStore()
    const snap = await r.store.list()
    expect(snap.panels).toHaveLength(1)
    expect(snap.panels[0]?.installed).toBe(false)
    expect(snap.panels[0]?.updatable).toBe(false)
  })

  it("已安装时读磁盘上的版本，索引更高则可更新", async () => {
    const r = await freshStore()
    const dir = join(r.panelsDir, "hardware")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }), "utf8")

    const snap = await r.store.list()
    expect(snap.panels[0]?.installed).toBe(true)
    expect(snap.panels[0]?.installedVersion).toBe("0.3.0")
    expect(snap.panels[0]?.updatable).toBe(true)
  })

  it("已装版本与索引一致时不算可更新", async () => {
    const r = await freshStore()
    const dir = join(r.panelsDir, "hardware")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }), "utf8")
    expect((await r.store.list()).panels[0]?.updatable).toBe(false)
  })

  it("已装版本更高时不算可更新 —— 那是使用者自己装了预览版，商店不该劝他退回去", async () => {
    const r = await freshStore()
    const dir = join(r.panelsDir, "hardware")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.9.0" }), "utf8")
    expect((await r.store.list()).panels[0]?.updatable).toBe(false)
  })

  it("已装但读不到版本时不算可更新 —— 无从比较，标成可更新会让人白点一次", async () => {
    const r = await freshStore()
    await mkdir(join(r.panelsDir, "hardware"), { recursive: true })
    const snap = await r.store.list()
    expect(snap.panels[0]?.installed).toBe(true)
    expect(snap.panels[0]?.installedVersion).toBeUndefined()
    expect(snap.panels[0]?.updatable).toBe(false)
  })

  it("索引没写版本时不算可更新", async () => {
    const { version: _v, ...noVersion } = HARDWARE
    const r = await freshStore({ index: { panels: [noVersion] } })
    const dir = join(r.panelsDir, "hardware")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }), "utf8")
    expect((await r.store.list()).panels[0]?.updatable).toBe(false)
  })

  it("只读开关随快照送出，供前端隐去按钮", async () => {
    const r = await freshStore({ core: { mirror: "", readonly: true } })
    expect((await r.store.list()).readonly).toBe(true)
  })

  it("索引取不到时记进 sources 而非抛错，且条目为空", async () => {
    const panels = await tempDir()
    const temp = await tempDir()
    const cacheFile = join(await tempDir(), "cache.json")
    const store = new PanelStore({
      http: {
        get: async () => {
          throw new Error("ENOTFOUND")
        },
        buffer: async () => {
          throw new Error("n/a")
        }
      } as unknown as PanelStoreDeps["http"],
      logger: { warn: () => undefined, error: () => undefined, debug: () => undefined },
      panelsDir: panels,
      tempDir: temp,
      cacheFile,
      settings: () => ({ sources: ["https://example.invalid/x.json"], cacheTtl: 3600_000, timeout: 100 }),
      core: async () => ({ mirror: "", readonly: false }),
      webuiVersion: "0.1.0"
    })
    const snap = await store.list()
    expect(snap.panels).toHaveLength(0)
    expect(snap.sources[0]?.ok).toBe(false)
    expect(snap.sources[0]?.error).toContain("ENOTFOUND")
  })

  it("缓存落盘后可在无网络时沿用", async () => {
    const r = await freshStore()
    await r.store.list()
    const cached = JSON.parse(await readFile(r.cacheFile, "utf8")) as { entries: PanelStoreEntry[] }
    expect(cached.entries[0]?.name).toBe("hardware")
  })
})

describe("install", () => {
  it("装完落在 <落点>/<名>，且带 node 侧与依赖需求两项事实", async () => {
    const r = await freshStore({
      git: async (args, cwd) => {
        if (args[0] === "clone") {
          const dest = args[args.length - 1] ?? ""
          await mkdir(dest, { recursive: true })
          await writeFile(
            join(dest, "package.json"),
            JSON.stringify({ version: "0.4.0", dependencies: { systeminformation: "^5" }, webuiPanel: { server: "dist/index.js" } }),
            "utf8"
          )
          await writeFile(join(dest, "index.js"), "export const meta = {}", "utf8")
        }
        return cwd === "" ? "" : ""
      }
    })
    const done = await r.store.install("hardware")
    expect(done.dir).toBe(join(r.panelsDir, "hardware"))
    expect(done.version).toBe("0.4.0")
    expect(done.hasServer).toBe(true)
    expect(done.needsDependencies).toBe(true)
    expect(done.installedDeps).toBeUndefined()
  })

  it("勾了装依赖就跑包管理器，且跑在包目录里", async () => {
    const r = await freshStore({
      git: async args => {
        if (args[0] === "clone") {
          const dest = args[args.length - 1] ?? ""
          await mkdir(dest, { recursive: true })
          await writeFile(join(dest, "package.json"), JSON.stringify({ version: "1.0.0", dependencies: { x: "^1" } }), "utf8")
          await writeFile(join(dest, "index.js"), "", "utf8")
        }
        return ""
      }
    })
    const done = await r.store.install("hardware", { dependencies: true })
    expect(r.installs).toEqual([join(r.panelsDir, "hardware")])
    expect(done.installedDeps).toBe(true)
    expect(done.packageManager).toBe("pnpm")
    expect(done.needsDependencies).toBe(false)
  })

  it("**依赖装失败不让整次安装失败** —— 包已经装好了，缺的只是依赖", async () => {
    const r = await freshStore({
      git: async args => {
        if (args[0] === "clone") {
          const dest = args[args.length - 1] ?? ""
          await mkdir(dest, { recursive: true })
          await writeFile(join(dest, "package.json"), JSON.stringify({ version: "1.0.0", dependencies: { x: "^1" } }), "utf8")
          await writeFile(join(dest, "index.js"), "", "utf8")
        }
        return ""
      },
      install: async () => {
        throw new Error("离线")
      }
    })
    const done = await r.store.install("hardware", { dependencies: true })
    expect(done.installedDeps).toBe(false)
    expect(done.dependencyError).toContain("离线")
    expect(done.needsDependencies).toBe(true)
    expect(r.errors.join()).toMatch(/自行执行包管理器/)
  })

  it("**没声明依赖的包不跑包管理器**，即便勾了", async () => {
    const r = await freshStore()
    const done = await r.store.install("hardware", { dependencies: true })
    expect(r.installs).toEqual([])
    expect(done.needsDependencies).toBe(false)
  })

  it("目标已存在且未给 replace 时拒绝", async () => {
    const r = await freshStore()
    await mkdir(join(r.panelsDir, "hardware"), { recursive: true })
    await expect(r.store.install("hardware")).rejects.toThrow(/已安装/)
  })

  it("索引里没有的名字拒绝", async () => {
    const r = await freshStore()
    await expect(r.store.install("nothere")).rejects.toThrow(/没有名为 nothere/)
  })

  it.each(["../evil", "node_modules", ".git"])("名字 %s 一律拒绝，不做纠正后重试", async name => {
    const r = await freshStore()
    await expect(r.store.install(name)).rejects.toThrow(/名不合法/)
  })

  it("**minWebui 高于当前 webui 版本时拒绝，且说的是 webui 而非内核**", async () => {
    const r = await freshStore({ index: { panels: [{ ...HARDWARE, minWebui: "0.9.0" }] }, webuiVersion: "0.1.0" })
    await expect(r.store.install("hardware")).rejects.toThrow(/要求 webui 版本不低于 0\.9\.0/)
  })

  it("取到的内容缺 index.js 时报错，且说清包该长什么样；落点保持原状", async () => {
    const r = await freshStore({
      git: async args => {
        if (args[0] === "clone") {
          const dest = args[args.length - 1] ?? ""
          await mkdir(dest, { recursive: true })
          await writeFile(join(dest, "package.json"), "{}", "utf8")
        }
        return ""
      }
    })
    await expect(r.store.install("hardware")).rejects.toThrow(/缺少 index\.js/)
    await expect(readFile(join(r.panelsDir, "hardware", "package.json"), "utf8")).rejects.toThrow()
  })

  it("只读模式下拒绝，文案与内核那条一致", async () => {
    const r = await freshStore({ core: { mirror: "", readonly: true } })
    await expect(r.store.install("hardware")).rejects.toThrow(/只读模式（配置项 server\.readonly 为 true）/)
  })

  it("clone 带 --depth 1 --single-branch 与索引声明的分支", async () => {
    const r = await freshStore()
    await r.store.install("hardware")
    const clone = r.gits.find(call => call.args[0] === "clone")
    expect(clone?.args).toContain("--depth")
    expect(clone?.args).toContain("--single-branch")
    expect(clone?.args).toContain("--branch")
    expect(clone?.args).toContain("main")
  })

  it("镜像前缀作用在 clone 的地址上", async () => {
    const r = await freshStore({ core: { mirror: "https://gh-proxy.org/", readonly: false } })
    await r.store.install("hardware")
    const clone = r.gits.find(call => call.args[0] === "clone")
    expect(clone?.args.join(" ")).toContain("https://gh-proxy.org/https://github.com/Yunzai-NG/hardware-plugin")
  })
})

describe("update 的就地拉取", () => {
  /**
   * 备一个已装且是 git 仓库的包
   * @param panelsDir 落点
   * @param version 磁盘上的版本
   * @param dirty 是否有未提交的改动
   * @returns 包目录
   */
  async function installed(panelsDir: string, version = "0.3.0"): Promise<string> {
    const dir = join(panelsDir, "hardware")
    await mkdir(join(dir, ".git"), { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version }), "utf8")
    await writeFile(join(dir, "index.js"), "", "utf8")
    return dir
  }

  it("**stash 先于 reset** —— 次序反了就是数据丢失，而两种次序都能得到一个内容正确的目录", async () => {
    const r = await freshStore({
      git: async args => {
        if (args[0] === "rev-parse") return "aaaaaaa\n"
        // 目录里有未提交的改动
        if (args[0] === "status") return " M index.js\n"
        return ""
      }
    })
    await installed(r.panelsDir)
    await r.store.update("hardware")

    const order = r.gits.map(call => call.args[0])
    const stashAt = order.indexOf("stash")
    const resetAt = order.indexOf("reset")
    expect(stashAt).toBeGreaterThanOrEqual(0)
    expect(resetAt).toBeGreaterThanOrEqual(0)
    expect(stashAt).toBeLessThan(resetAt)
  })

  it("stash 带 --include-untracked —— 新增的文件同样会被 checkout 撞上", async () => {
    const r = await freshStore({
      git: async args => {
        if (args[0] === "rev-parse") return "aaaaaaa\n"
        if (args[0] === "status") return "?? new.js\n"
        return ""
      }
    })
    await installed(r.panelsDir)
    await r.store.update("hardware")
    const stash = r.gits.find(call => call.args[0] === "stash")
    expect(stash?.args).toContain("--include-untracked")
    expect(r.warns.join()).toMatch(/git stash pop/)
  })

  it("目录干净时不 stash —— 一次无谓的 stash 会在使用者的仓库里留下一条记录", async () => {
    const r = await freshStore({
      git: async args => {
        if (args[0] === "rev-parse") return "aaaaaaa\n"
        if (args[0] === "status") return ""
        return ""
      }
    })
    await installed(r.panelsDir)
    await r.store.update("hardware")
    expect(r.gits.some(call => call.args[0] === "stash")).toBe(false)
  })

  it("**用 fetch + reset --hard，不用 pull**", async () => {
    const r = await freshStore({
      git: async args => (args[0] === "rev-parse" ? "aaaaaaa\n" : "")
    })
    await installed(r.panelsDir)
    await r.store.update("hardware")
    expect(r.gits.some(call => call.args[0] === "pull")).toBe(false)
    const fetch = r.gits.find(call => call.args[0] === "fetch")
    expect(fetch?.args).toEqual(["fetch", "--depth", "1", "https://github.com/Yunzai-NG/hardware-plugin", "main"])
    expect(r.gits.find(call => call.args[0] === "reset")?.args).toEqual(["reset", "--hard", "FETCH_HEAD"])
  })

  it("**fetch 的地址每次现算**，不沿用目录里的 origin —— 换过镜像的人否则永远更新失败", async () => {
    const r = await freshStore({
      core: { mirror: "https://gh-proxy.org/", readonly: false },
      git: async args => (args[0] === "rev-parse" ? "aaaaaaa\n" : "")
    })
    await installed(r.panelsDir)
    await r.store.update("hardware")
    const fetch = r.gits.find(call => call.args[0] === "fetch")
    expect(fetch?.args[3]).toBe("https://gh-proxy.org/https://github.com/Yunzai-NG/hardware-plugin")
  })

  it("HEAD 没变时 changed 为假 —— 面板据此说「已是最新」而非「已更新」", async () => {
    const r = await freshStore({
      git: async args => (args[0] === "rev-parse" ? "samehash\n" : "")
    })
    await installed(r.panelsDir)
    const done = await r.store.update("hardware")
    expect(done.via).toBe("pull")
    expect(done.changed).toBe(false)
  })

  it("HEAD 变了时 changed 为真，且带上旧版本号供显示「0.3.0 → 0.4.0」", async () => {
    let calls = 0
    const r = await freshStore({
      git: async (args, cwd) => {
        if (args[0] === "rev-parse") {
          calls += 1
          return calls === 1 ? "oldhash\n" : "newhash\n"
        }
        if (args[0] === "reset") {
          // 拉取之后磁盘上的版本变了
          await writeFile(join(cwd, "package.json"), JSON.stringify({ version: "0.4.0" }), "utf8")
        }
        return ""
      }
    })
    await installed(r.panelsDir)
    const done = await r.store.update("hardware")
    expect(done.changed).toBe(true)
    expect(done.fromVersion).toBe("0.3.0")
    expect(done.version).toBe("0.4.0")
  })

  it("目录不是 git 仓库时**退回重装**，via 为 git 而非 pull", async () => {
    const r = await freshStore()
    const dir = join(r.panelsDir, "hardware")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }), "utf8")
    const done = await r.store.update("hardware")
    expect(done.via).toBe("git")
  })

  it("**拉取本身失败要抛错，不退回重装** —— 否则一次可修复的失败会变成一次目录删除", async () => {
    const r = await freshStore({
      git: async args => {
        if (args[0] === "rev-parse") return "aaaaaaa\n"
        if (args[0] === "fetch") throw new Error("git fetch 失败：网络不可达")
        return ""
      }
    })
    await installed(r.panelsDir)
    await expect(r.store.update("hardware")).rejects.toThrow(/网络不可达/)
    // 目录仍在，没有被删掉重下
    expect(JSON.parse(await readFile(join(r.panelsDir, "hardware", "package.json"), "utf8"))).toMatchObject({
      version: "0.3.0"
    })
  })

  it("只读模式下拒绝更新", async () => {
    const r = await freshStore({ core: { mirror: "", readonly: true } })
    await installed(r.panelsDir)
    await expect(r.store.update("hardware")).rejects.toThrow(/只读模式/)
  })
})

describe("remove", () => {
  it("删掉包目录", async () => {
    const r = await freshStore()
    const dir = join(r.panelsDir, "hardware")
    await mkdir(dir, { recursive: true })
    expect(await r.store.remove("hardware")).toBe(true)
    await expect(readFile(join(dir, "package.json"), "utf8")).rejects.toThrow()
  })

  it("目录本就不存在时给假，不抛错", async () => {
    const r = await freshStore()
    expect(await r.store.remove("hardware")).toBe(false)
  })

  it("名字不合法时拒绝 —— 这一条挡的是「删到落点之外去」", async () => {
    const r = await freshStore()
    await expect(r.store.remove("../../etc")).rejects.toThrow(/名不合法/)
  })

  it("只读模式下拒绝删除", async () => {
    const r = await freshStore({ core: { mirror: "", readonly: true } })
    await mkdir(join(r.panelsDir, "hardware"), { recursive: true })
    await expect(r.store.remove("hardware")).rejects.toThrow(/只读模式/)
  })
})
