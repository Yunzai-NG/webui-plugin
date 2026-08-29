/**
 * 模块职责：面板插件扫描的用例
 * 依赖方向：测试文件，依赖 panelscan.ts
 * 生命周期：一次性
 * 注意事项：**目录穿越那几条是本文件的重点。** 归属名来自 package.json、文件名来自
 *          使用者，两者都不可信；拼错一次就是一条能读到任意文件的 URL。这类缺陷
 *          不会表现为报错，只会安静地存在，故非有用例钉住不可。
 *
 *          「被挡下的要出声」同样有断言：静默跳过之后使用者看到的是「文件放进去了
 *          但没反应」，而改名与先编译是两种完全不同的处置。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  MULTI_ENTRY,
  PANELS_OWNER,
  entryOf,
  isPanelFile,
  isSafeEntryPath,
  isSafeName,
  listDirFiles,
  metaFromPackageJson,
  mountOf,
  ownerFromRepo,
  packageInfoFrom,
  pickPanelFiles,
  scanPanels,
  scanPanelsDir
} from "./panelscan.js"

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
  const dir = await mkdtemp(join(tmpdir(), "yzng-panelscan-"))
  dirs.push(dir)
  return dir
}

/**
 * 在某目录下造几个文件
 * @param dir 目录（会被创建）
 * @param names 文件名
 */
async function seed(dir: string, names: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await Promise.all(names.map(name => writeFile(join(dir, name), "export default {}", "utf8")))
}

describe("isSafeName", () => {
  it("放行字母、数字与 . _ -", () => {
    expect(isSafeName("hardware.js")).toBe(true)
    expect(isSafeName("my-widget_2.mjs")).toBe(true)
  })

  it("挡下目录穿越与路径分隔符", () => {
    for (const bad of ["..", ".", "../etc/passwd", "a/b.js", "a\\b.js", "a:b.js"]) {
      expect(isSafeName(bad)).toBe(false)
    }
  })

  it("挡下非 ASCII 名字：它拼进 URL 后要转义，而清单里的原文与之不符", () => {
    expect(isSafeName("硬件.js")).toBe(false)
  })

  it("挡下空串", () => {
    expect(isSafeName("")).toBe(false)
  })
})

describe("isPanelFile", () => {
  it("只认 .js 与 .mjs", () => {
    expect(isPanelFile("a.js")).toBe(true)
    expect(isPanelFile("a.mjs")).toBe(true)
    expect(isPanelFile("a.ts")).toBe(false)
    expect(isPanelFile("a.json")).toBe(false)
    expect(isPanelFile("README")).toBe(false)
  })

  it("名字不安全时即使扩展名对也不认", () => {
    expect(isPanelFile("../evil.js")).toBe(false)
  })
})

describe("pickPanelFiles", () => {
  it("挑出合格文件，不出声", () => {
    const warns: string[] = []
    expect(pickPanelFiles(["b.mjs", "a.js"], "/d", m => void warns.push(m))).toEqual(["b.mjs", "a.js"])
    expect(warns).toEqual([])
  })

  it("遇 .ts 出声，且提示里说明须是手写 js", () => {
    const warns: string[] = []
    expect(pickPanelFiles(["a.ts"], "/d", m => void warns.push(m))).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("a.ts")
    expect(warns[0]).toContain(".js")
  })

  it("扩展名对但名字不能进 URL 时出声，且提示里给出可用字符", () => {
    const warns: string[] = []
    expect(pickPanelFiles(["硬件.js"], "/d", m => void warns.push(m))).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain("硬件.js")
  })

  it("对 .map / README 一类不出声：它们本就不是想被加载的东西", () => {
    const warns: string[] = []
    expect(pickPanelFiles(["a.js.map", "README.md", "package.json"], "/d", m => void warns.push(m))).toEqual([])
    expect(warns).toEqual([])
  })
})

describe("URL 拼装", () => {
  it("清单地址落在 webui 自己的 scope 之下", () => {
    expect(entryOf(PANELS_OWNER, "a.js").url).toBe("/plugin/webui/pp/panels/a.js")
    expect(entryOf(PANELS_OWNER, "pkg/index.js").url).toBe("/plugin/webui/pp/panels/pkg/index.js")
  })

  it("挂载路径相对 scope，不含前导斜杠", () => {
    expect(mountOf(PANELS_OWNER, "/d").urlPath).toBe("pp/panels")
  })
})

describe("listDirFiles", () => {
  it("目录不存在时给空数组，不抛错 —— 多数插件不带 panel/", async () => {
    const dir = await tempDir()
    expect(await listDirFiles(join(dir, "nope"))).toEqual([])
  })

  it("只列文件，子目录不列", async () => {
    const dir = await tempDir()
    await seed(dir, ["a.js"])
    await mkdir(join(dir, "sub"))
    expect(await listDirFiles(dir)).toEqual(["a.js"])
  })

  it("按名排序，使清单顺序不取决于文件系统的返回顺序", async () => {
    const dir = await tempDir()
    await seed(dir, ["c.js", "a.js", "b.js"])
    expect(await listDirFiles(dir)).toEqual(["a.js", "b.js", "c.js"])
  })
})

describe("ownerFromRepo", () => {
  it("取路径上倒数第二段，git+ 前缀与 .git 后缀都不妨碍", () => {
    expect(ownerFromRepo("git+https://github.com/Yunzai-NG/hardware-plugin.git")).toBe("Yunzai-NG")
    expect(ownerFromRepo("https://gitee.com/someone/thing")).toBe("someone")
  })

  it("认 SSH 写法：冒号后面也是「归属/仓库」两段", () => {
    expect(ownerFromRepo("git@github.com:Yunzai-NG/x.git")).toBe("Yunzai-NG")
  })

  it("不足两段时推不出", () => {
    expect(ownerFromRepo("local")).toBeUndefined()
  })
})

describe("metaFromPackageJson", () => {
  /**
   * 造一份 package.json 文本
   * @param patch 字段
   * @returns JSON 文本
   */
  const pkg = (patch: Record<string, unknown>): string => JSON.stringify(patch)

  it("三项齐备即可，author 另给时用它", () => {
    expect(
      metaFromPackageJson(
        pkg({ version: "1.0.0", description: "说明", repository: "https://github.com/a/b", author: "某人" })
      )
    ).toEqual({ version: "1.0.0", description: "说明", repository: "https://github.com/a/b", author: "某人" })
  })

  /*
   * 这一条钉的是「拿 author 当门槛」那个错
   *
   * 本项目自己的五个插件的 package.json 一个都没写 author —— npm 里它本就是可选字段。
   * 初版把四项都列作必需，于是 hardware 那三枚示例组件在面板上变成三格红字，
   * 而它们并没写错什么。规则错了要改规则，不是让示例去迁就规则。
   */
  it("缺 author 时从仓库地址推出归属名 —— npm 里 author 本就常缺", () => {
    const meta = metaFromPackageJson(
      pkg({
        version: "0.1.0",
        description: "硬件信息插件",
        repository: { type: "git", url: "git+https://github.com/Yunzai-NG/hardware-plugin.git" }
      })
    )
    expect(meta?.author).toBe("Yunzai-NG")
  })

  it("author 的对象写法取 name", () => {
    const meta = metaFromPackageJson(
      pkg({ version: "1.0.0", description: "说明", repository: "https://github.com/a/b", author: { name: "某人", email: "a@b.c" } })
    )
    expect(meta?.author).toBe("某人")
  })

  it.each(["version", "description", "repository"])("缺 %s 即整份作废", key => {
    const base: Record<string, unknown> = {
      version: "1.0.0",
      description: "说明",
      repository: "https://github.com/a/b"
    }
    const rest = Object.fromEntries(Object.entries(base).filter(([k]) => k !== key))
    expect(metaFromPackageJson(pkg(rest))).toBeUndefined()
  })

  it("不是合法 JSON 时给 undefined，不抛错", () => {
    expect(metaFromPackageJson("{ 这不是 json")).toBeUndefined()
    expect(metaFromPackageJson("[]")).toBeUndefined()
  })
})

describe("scanPanelsDir", () => {
  /**
   * 造一个 webui 安装目录，其下备好 `plugins/`
   * @returns 安装目录与主路目录
   */
  async function root(): Promise<{ root: string; dir: string }> {
    const r = await tempDir()
    const dir = join(r, "plugins")
    await mkdir(dir, { recursive: true })
    return { root: r, dir }
  }

  it("顶层的 js 记作 single，且不带 meta —— 由浏览器侧从模块导出取", async () => {
    const { root: r, dir } = await root()
    await seed(dir, ["clock.js"])
    const warns: string[] = []

    const scan = await scanPanelsDir(r, m => void warns.push(m))

    expect(scan.entries).toEqual([
      { owner: PANELS_OWNER, file: "clock.js", url: "/plugin/webui/pp/panels/clock.js", kind: "single" }
    ])
    expect(warns).toEqual([])
  })

  it("只挂一处静态目录（整个 plugins/），故多文件插件的相对 import 与 lib/ 一并可取", async () => {
    const { root: r, dir } = await root()
    const scan = await scanPanelsDir(r, () => undefined)

    expect(scan.mount).toEqual({ urlPath: "pp/panels", dir, owner: PANELS_OWNER })
  })

  it("子目录取 index.js 作入口，记作 multi，并读它的 package.json", async () => {
    const { root: r, dir } = await root()
    const sub = join(dir, "weather")
    await seed(sub, [MULTI_ENTRY])
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({ version: "2.0.0", description: "天气", repository: "https://github.com/a/weather" }),
      "utf8"
    )

    const scan = await scanPanelsDir(r, () => undefined)

    expect(scan.entries).toEqual([
      {
        owner: PANELS_OWNER,
        file: `weather/${MULTI_ENTRY}`,
        url: `/plugin/webui/pp/panels/weather/${MULTI_ENTRY}`,
        kind: "multi",
        meta: { version: "2.0.0", description: "天气", repository: "https://github.com/a/weather", author: "a" }
      }
    ])
  })

  it("多文件缺 package.json 时仍进清单，带 meta: undefined —— 占位格上的红字才是使用者真会看到的", async () => {
    const { root: r, dir } = await root()
    await seed(join(dir, "naked"), [MULTI_ENTRY])

    const scan = await scanPanelsDir(r, () => undefined)

    expect(scan.entries).toHaveLength(1)
    expect(scan.entries[0]?.meta).toBeUndefined()
    expect(scan.entries[0]?.kind).toBe("multi")
  })

  it("声明了 webuiPanel.style 且那份 css 真在，清单里给出可直接取用的地址", async () => {
    const { root: r, dir } = await root()
    const sub = join(dir, "themed")
    await seed(sub, [MULTI_ENTRY, "skin.css"])
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({
        version: "1.0.0",
        description: "带皮肤",
        repository: "https://github.com/a/themed",
        webuiPanel: { style: "skin.css" }
      }),
      "utf8"
    )

    const scan = await scanPanelsDir(r, () => undefined)

    expect(scan.entries[0]?.style).toBe("/plugin/webui/pp/panels/themed/skin.css")
    expect(scan.entries[0]?.styleError).toBeUndefined()
    expect(scan.packages[0]?.styleEntry).toBe("skin.css")
  })

  it("**声明了却没有那个文件时在此判掉**，不留给浏览器去撞静态目录的 404 页", async () => {
    const { root: r, dir } = await root()
    const sub = join(dir, "typo")
    await seed(sub, [MULTI_ENTRY])
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({
        version: "1.0.0",
        description: "路径写错了",
        repository: "https://github.com/a/typo",
        webuiPanel: { style: "styles.css" }
      }),
      "utf8"
    )
    const warns: string[] = []

    const scan = await scanPanelsDir(r, m => void warns.push(m))

    // 那份 404 页是 HTML，当成 css 送进限定与注入只会「样式没生效」而控制台一言不发
    expect(scan.entries[0]?.style).toBeUndefined()
    expect(scan.entries[0]?.styleError).toContain("styles.css")
    expect(scan.packages[0]?.styleEntry).toBeUndefined()
    expect(warns.some(item => item.includes("styles.css"))).toBe(true)
  })

  it("样式表声明有问题不影响这个包的其余部分 —— 组件照常上板", async () => {
    const { root: r, dir } = await root()
    const sub = join(dir, "half")
    await seed(sub, [MULTI_ENTRY])
    await writeFile(
      join(sub, "package.json"),
      JSON.stringify({
        version: "3.0.0",
        description: "样式坏了别的没坏",
        repository: "https://github.com/a/half",
        webuiPanel: { style: "../outside.css" }
      }),
      "utf8"
    )

    const scan = await scanPanelsDir(r, () => undefined)

    expect(scan.entries).toHaveLength(1)
    expect(scan.entries[0]?.meta?.version).toBe("3.0.0")
    expect(scan.entries[0]?.styleError).toBeDefined()
  })

  it("子目录缺 index.js 时出声并跳过 —— 静默跳过等于「装了却什么都没有」", async () => {
    const { root: r, dir } = await root()
    await seed(join(dir, "wrong-level"), ["widget.js"])
    const warns: string[] = []

    const scan = await scanPanelsDir(r, m => void warns.push(m))

    expect(scan.entries).toEqual([])
    expect(warns[0]).toContain(MULTI_ENTRY)
  })

  it("主路目录不存在时给空清单，但仍给出挂载 —— 放进第一个文件后刷新即生效", async () => {
    const bare = await tempDir()
    const scan = await scanPanelsDir(bare, () => undefined)

    expect(scan.entries).toEqual([])
    expect(scan.mount.owner).toBe(PANELS_OWNER)
  })
})

describe("scanPanels", () => {
  /**
   * 造一份扫描依赖
   * @param webuiRoot webui 的安装目录；不给即模拟「取不到」
   * @returns 依赖与收到的警告
   */
  function deps(webuiRoot?: string): { deps: Parameters<typeof scanPanels>[0]; warns: string[] } {
    const warns: string[] = []
    return { deps: { ...(webuiRoot === undefined ? {} : { webuiRoot }), warn: m => void warns.push(m) }, warns }
  }

  it("目录恒被挂载，即使它此刻不存在 —— 放进第一个文件后刷新即生效", async () => {
    const root = await tempDir()
    const scan = await scanPanels(deps(root).deps)

    expect(scan.mounts).toEqual([{ urlPath: "pp/panels", dir: join(root, "plugins"), owner: PANELS_OWNER }])
    expect(scan.entries).toEqual([])
  })

  it("**只有这一路**：webuiRoot 取不到时什么都不给，不去别处找", async () => {
    const scan = await scanPanels(deps().deps)

    expect(scan.mounts).toEqual([])
    expect(scan.entries).toEqual([])
    expect(scan.packages).toEqual([])
  })

  it("列出单文件与目录包，归属恒为 panels", async () => {
    const root = await tempDir()
    const dir = join(root, "plugins")
    await seed(dir, ["a.js", "b.mjs"])
    await seed(join(dir, "pkg"), [MULTI_ENTRY])

    const scan = await scanPanels(deps(root).deps)

    expect(scan.entries.map(e => e.file)).toEqual(["a.js", "b.mjs", `pkg/${MULTI_ENTRY}`])
    expect(scan.entries.every(e => e.owner === PANELS_OWNER)).toBe(true)
  })

  it("目录包声明了 node 侧入口时给出包与接口基地址", async () => {
    const root = await tempDir()
    const pkg = join(root, "plugins", "hardware")
    await seed(pkg, [MULTI_ENTRY])
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        version: "1.0.0",
        description: "硬件",
        repository: "https://github.com/a/hardware",
        webuiPanel: { server: "dist/index.js" },
        dependencies: { systeminformation: "5.33.2" }
      }),
      "utf8"
    )

    const scan = await scanPanels(deps(root).deps)

    expect(scan.packages).toEqual([
      {
        owner: PANELS_OWNER,
        name: "hardware",
        dir: pkg,
        meta: { version: "1.0.0", description: "硬件", repository: "https://github.com/a/hardware", author: "a" },
        serverEntry: "dist/index.js",
        needsInstall: true
      }
    ])
    // 有 node 侧的包，清单里带上它的接口基地址 —— 组件不必自己拼前缀
    expect(scan.entries[0]?.api).toBe("/plugin/webui/papi/panels/hardware")
    expect(scan.entries[0]?.kind).toBe("multi")
  })

  it("没有 node 侧入口的包不给 api 地址 —— 给了就是一条稳定 404", async () => {
    const root = await tempDir()
    const pkg = join(root, "plugins", "clockpkg")
    await seed(pkg, [MULTI_ENTRY])
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ version: "1.0.0", description: "钟", repository: "https://github.com/a/c" }),
      "utf8"
    )

    const scan = await scanPanels(deps(root).deps)

    expect(scan.entries[0]?.api).toBeUndefined()
    expect(scan.packages[0]?.serverEntry).toBeUndefined()
    expect(scan.packages[0]?.needsInstall).toBe(false)
  })

  it("单文件不成包 —— 它没有 package.json 可依，也无从有 node 侧", async () => {
    const root = await tempDir()
    await seed(join(root, "plugins"), ["solo.js"])

    const scan = await scanPanels(deps(root).deps)

    expect(scan.packages).toEqual([])
  })

  it("包声明的配置随包给出；清单里的那一份由清单端点装配，故此处 entry 上还没有", async () => {
    const root = await tempDir()
    const pkg = join(root, "plugins", "watch")
    await seed(pkg, [MULTI_ENTRY])
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        version: "1.0.0",
        description: "看",
        repository: "https://github.com/a/w",
        webuiPanel: { config: { type: "object", properties: { host: { type: "string" } } } }
      }),
      "utf8"
    )

    const scan = await scanPanels(deps(root).deps)

    expect(scan.packages[0]?.config?.properties?.host).toEqual({ type: "string" })
    expect(scan.entries[0]?.config).toBeUndefined()
  })

  it("**配置声明写坏时出声**，且这个包的其余部分照常装上", async () => {
    const root = await tempDir()
    const pkg = join(root, "plugins", "broken")
    await seed(pkg, [MULTI_ENTRY])
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        version: "1.0.0",
        description: "坏",
        repository: "https://github.com/a/b",
        webuiPanel: { config: { type: "object", properties: { port: { type: "int" } } } }
      }),
      "utf8"
    )

    const got = deps(root)
    const scan = await scanPanels(got.deps)

    expect(got.warns.some(line => line.includes("没有可配置项"))).toBe(true)
    expect(scan.packages[0]?.config).toBeUndefined()
    expect(scan.packages[0]?.configError).toContain("配置字段 port")
    expect(scan.entries[0]?.file).toBe(`broken/${MULTI_ENTRY}`)
  })
})

describe("isSafeEntryPath", () => {
  it("放行 dist/ 之下的子路径：TypeScript 写的包产物就在那里", () => {
    expect(isSafeEntryPath("server.js")).toBe(true)
    expect(isSafeEntryPath("dist/index.js")).toBe(true)
    expect(isSafeEntryPath("build/node/main.mjs")).toBe(true)
  })

  it("挡下 `..`、绝对路径与盘符写法", () => {
    for (const bad of ["", "../evil.js", "a/../../b.js", "/etc/passwd", "C:\\x.js", "a b.js"]) {
      expect(isSafeEntryPath(bad), bad).toBe(false)
    }
  })
})

describe("packageInfoFrom", () => {
  /**
   * 造一份 package.json 文本
   * @param over 覆盖字段
   * @returns JSON 文本
   */
  function pkg(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: "1.0.0",
      description: "示例",
      repository: "https://github.com/a/b",
      ...over
    })
  }

  it("**needsInstall 由 dependencies 是否非空判定**，而非另立一个字段", () => {
    expect(packageInfoFrom(pkg({ dependencies: { si: "1" } })).needsInstall).toBe(true)
    expect(packageInfoFrom(pkg({ dependencies: {} })).needsInstall).toBe(false)
    expect(packageInfoFrom(pkg()).needsInstall).toBe(false)
  })

  it("留一个逃生口：依赖已打进产物时由包自己说 install: false", () => {
    const text = pkg({ dependencies: { si: "1" }, webuiPanel: { install: false } })
    expect(packageInfoFrom(text).needsInstall).toBe(false)
  })

  it("取 node 侧入口的文件名，含不能进 URL 的字符时当作没声明", () => {
    expect(packageInfoFrom(pkg({ webuiPanel: { server: "server.js" } })).serverEntry).toBe("server.js")
    // 比文件名宽一层：TypeScript 写的包产物就在 dist/ 下
    expect(packageInfoFrom(pkg({ webuiPanel: { server: "dist/server.js" } })).serverEntry).toBe("dist/server.js")
    expect(packageInfoFrom(pkg({ webuiPanel: { server: "../evil.js" } })).serverEntry).toBeUndefined()
    expect(packageInfoFrom(pkg({ webuiPanel: { server: "/etc/passwd" } })).serverEntry).toBeUndefined()
    expect(packageInfoFrom(pkg({ webuiPanel: { server: "C:\\x.js" } })).serverEntry).toBeUndefined()
    expect(packageInfoFrom(pkg({ webuiPanel: { server: 42 } })).serverEntry).toBeUndefined()
    expect(packageInfoFrom(pkg()).serverEntry).toBeUndefined()
  })

  it("自报信息与 metaFromPackageJson 同一份规则", () => {
    expect(packageInfoFrom(pkg()).meta).toEqual({
      version: "1.0.0",
      description: "示例",
      repository: "https://github.com/a/b",
      author: "a"
    })
    expect(packageInfoFrom(JSON.stringify({ version: "1.0.0" })).meta).toBeUndefined()
  })

  it("整份文档不是 JSON 或不是对象时给「什么都没有」而非抛错", () => {
    expect(packageInfoFrom("这不是 json")).toEqual({ needsInstall: false })
    expect(packageInfoFrom("[1,2]")).toEqual({ needsInstall: false })
  })

  it("读出 webuiPanel.config 里的配置声明", () => {
    const schema = { type: "object", properties: { host: { type: "string", default: "127.0.0.1" } } }
    expect(packageInfoFrom(pkg({ webuiPanel: { config: schema } })).config).toEqual(schema)
  })

  it("没声明配置的包两项都没有", () => {
    const info = packageInfoFrom(pkg())
    expect(info.config).toBeUndefined()
    expect(info.configError).toBeUndefined()
  })

  it("**声明写坏时给出原因而不是静默丢弃** —— 否则作者只看到「配置按钮没出现」", () => {
    const info = packageInfoFrom(pkg({ webuiPanel: { config: { type: "object" } } }))
    expect(info.config).toBeUndefined()
    expect(info.configError).toContain("properties")
  })

  it("声明写坏不影响同一份 package.json 里的其余几项", () => {
    const info = packageInfoFrom(
      pkg({ dependencies: { si: "1" }, webuiPanel: { server: "dist/x.js", config: "散文" } })
    )
    expect(info.serverEntry).toBe("dist/x.js")
    expect(info.needsInstall).toBe(true)
    expect(info.meta?.version).toBe("1.0.0")
    expect(info.configError).toBeDefined()
  })

  it("读出 webuiPanel.style，子路径同样放行", () => {
    expect(packageInfoFrom(pkg({ webuiPanel: { style: "style.css" } })).styleEntry).toBe("style.css")
    expect(packageInfoFrom(pkg({ webuiPanel: { style: "dist/style.css" } })).styleEntry).toBe("dist/style.css")
  })

  it("没声明样式表的包两项都没有", () => {
    const info = packageInfoFrom(pkg())
    expect(info.styleEntry).toBeUndefined()
    expect(info.styleError).toBeUndefined()
  })

  it("**穿越与绝对路径一律挡下，且要说一句** —— 静默丢弃只会表现为「样式没生效」", () => {
    for (const bad of ["../../etc/x.css", "/etc/x.css", "C:\\x.css"]) {
      const info = packageInfoFrom(pkg({ webuiPanel: { style: bad } }))
      expect(info.styleEntry).toBeUndefined()
      expect(info.styleError).toBeDefined()
    }
  })

  it("**只认 .css**：浏览器不编译 scss / less，收下它只会得到一份不生效的样式", () => {
    const info = packageInfoFrom(pkg({ webuiPanel: { style: "style.scss" } }))
    expect(info.styleEntry).toBeUndefined()
    expect(info.styleError).toContain(".css")
  })

  it("不是字符串时同样给出原因", () => {
    expect(packageInfoFrom(pkg({ webuiPanel: { style: 42 } })).styleError).toBeDefined()
    expect(packageInfoFrom(pkg({ webuiPanel: { style: true } })).styleError).toBeDefined()
  })

  it("样式表写坏不影响同一份 package.json 里的其余几项", () => {
    const info = packageInfoFrom(pkg({ webuiPanel: { server: "dist/x.js", style: "../evil.css" } }))
    expect(info.serverEntry).toBe("dist/x.js")
    expect(info.meta?.version).toBe("1.0.0")
    expect(info.styleError).toBeDefined()
  })
})
