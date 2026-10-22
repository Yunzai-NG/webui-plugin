/**
 * 模块职责：主题扫描、清单校验与样式表处理的用例
 * 依赖方向：测试文件，依赖 themescan.ts
 * 生命周期：一次性
 * 注意事项：**「主题只能用包内的文件」那几条是重点。** 一款主题能引外站图片，就能借选择器
 *          把页面上有什么回传出去；能用 `..` 走出包外，就能经资源路由读走任意文件。两类缺陷
 *          都不会表现为报错，非有用例钉住不可。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { NAV_IDS, SLOTS, checkThemeManifest, processThemeCss, readThemeAsset, scanThemes, themeBaseOf } from "./themescan.js"

/** 用例造出的临时目录，afterEach 统一清理 */
let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })))
  dirs = []
})

/**
 * 造一个 webui 安装目录，放进若干主题包
 * @param packs 包：目录（相对安装目录）→ 文件名 → 内容
 * @returns 安装目录
 */
async function webuiWith(packs: Record<string, Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yzng-theme-"))
  dirs.push(root)
  for (const [dir, files] of Object.entries(packs)) {
    for (const [file, text] of Object.entries(files)) {
      const path = join(root, dir, file)
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, text)
    }
  }
  return root
}

/**
 * 一份 package.json
 * @param theme webuiTheme 的内容
 * @returns 文本
 */
function pkg(theme: unknown): string {
  return JSON.stringify({ name: "x", version: "1.2.3", author: "someone", webuiTheme: theme })
}

describe("checkThemeManifest", () => {
  it("只有 id 与 name 是必填", () => {
    const got = checkThemeManifest({ id: "ayaka", name: "神里绫华" })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.manifest.schemes).toEqual([])
    expect(got.manifest.options).toEqual({ accentHue: true, radius: true, backdrop: true })
    expect(got.manifest.backdrop).toBe("gradient")
  })

  it("id 不合法时整款作废，并说清规则", () => {
    for (const id of ["", "Ayaka", "../x", "a b", "a".repeat(65)]) {
      const got = checkThemeManifest({ id, name: "x" })
      expect(got.ok).toBe(false)
    }
  })

  it("写坏的单项丢掉并警告，不作废整款", () => {
    const got = checkThemeManifest({
      id: "ayaka",
      name: "绫华",
      style: "../evil.css",
      slots: { "switch.thumb.on": "art/on.png", "switch.thumb.off": "https://x/y.png", nope: "a.png" },
      icons: { mode: "image", nav: { overview: "icons/o.png", nothere: "icons/n.png", plugins: "icons/p.txt" } }
    })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.manifest.style).toBeUndefined()
    expect(got.manifest.slots).toEqual({ "switch.thumb.on": "art/on.png" })
    expect(got.manifest.icons?.nav).toEqual({ overview: "icons/o.png" })
    expect(got.warnings.length).toBe(5)
  })

  it("描边图标只收 path 数据，挡住夹带的标签", () => {
    const got = checkThemeManifest({ id: "a", name: "a", icons: { nav: { overview: "M4 17a8 8 0 1 1 16 0", logs: '"/><script>' } } })
    expect(got.ok && got.manifest.icons?.nav).toEqual({ overview: "M4 17a8 8 0 1 1 16 0" })
  })

  it("图片槽位都可以分明暗给两张", () => {
    const got = checkThemeManifest({ id: "a", name: "a", slots: { "brand.lockup": { light: "l.svg", dark: "d.svg" }, empty: { dark: "e.png" } } })
    expect(got.ok && got.manifest.slots).toEqual({ "brand.lockup": { light: "l.svg", dark: "d.svg" }, empty: { dark: "e.png" } })
  })

  it("边框槽位要图与切片，缺省宽度取切片的一半", () => {
    const got = checkThemeManifest({ id: "a", name: "a", slots: { "frame.card": { image: "f.png", slice: 40 } } })
    expect(got.ok && got.manifest.slots["frame.card"]).toEqual({ image: "f.png", slice: 40, width: "20px", outset: "0px", repeat: "stretch" })
  })
})

describe("processThemeCss", () => {
  const base = themeBaseOf("ayaka")

  it("包内相对地址解析为资源路由上的绝对地址", () => {
    const { css } = processThemeCss(`.a { background: url(art/f.png) } .b { src: url("../fonts/x.woff2") }`, "css/theme.css", base, false)
    expect(css).toContain(`url("${base}/css/art/f.png")`)
    expect(css).toContain(`url("${base}/fonts/x.woff2")`)
  })

  it("外站、协议相对、根路径与走出包外的地址一律剔除并警告", () => {
    const src = [
      ".a{background:url(https://evil.example/p.png)}",
      ".b{background:url('//evil.example/p.png')}",
      ".c{background:url(/api/overview)}",
      ".d{background:url(../../etc/passwd)}",
      ".e{background:url(javascript:alert(1))}"
    ].join("\n")
    const { css, warnings } = processThemeCss(src, "theme.css", base, false)
    expect(css).not.toMatch(/evil|passwd|\/api\/|javascript/)
    expect(warnings.length).toBe(5)
  })

  it("data: 与片段引用放行", () => {
    const { css, warnings } = processThemeCss(`.a{mask:url(data:image/svg+xml;base64,AAA)} .b{fill:url(#g)}`, "theme.css", base, false)
    expect(css).toContain("url(\"data:image/svg+xml;base64,AAA\")")
    expect(css).toContain('url("#g")')
    expect(warnings).toEqual([])
  })

  it("入口样式表包进 @layer theme，打头的 @charset 与本地 @import 留在层外", () => {
    const { css } = processThemeCss(`@charset "utf-8";\n@import "parts.css";\n:root{--accent:red}`, "theme.css", base, true)
    expect(css.indexOf("@charset")).toBeLessThan(css.indexOf("@layer theme"))
    expect(css.indexOf(`@import url("${base}/parts.css")`)).toBeLessThan(css.indexOf("@layer theme"))
    expect(css).toMatch(/@layer theme \{\s*:root\{--accent:red\}\s*\}/)
  })

  it("外站的 @import 整条丢掉", () => {
    const { css, warnings } = processThemeCss(`@import url(https://fonts.example/x.css);\n.a{}`, "theme.css", base, true)
    expect(css).not.toContain("fonts.example")
    expect(warnings.length).toBe(1)
  })
})

describe("scanThemes", () => {
  it("内置的先扫、经典排第一，商店装的随后", async () => {
    const root = await webuiWith({
      "themes/pumpkin": { "package.json": pkg({ id: "pumpkin", name: "YUNZAI NG" }) },
      "themes/classic": { "package.json": pkg({ id: "classic", name: "经典" }) },
      "plugins/ayaka": { "package.json": pkg({ id: "ayaka", name: "绫华" }) },
      "plugins/plain": { "package.json": JSON.stringify({ name: "plain", version: "1.0.0" }), "index.js": "" }
    })
    const got = await scanThemes(root, () => undefined)
    expect(got.map(t => t.info.id)).toEqual(["classic", "pumpkin", "ayaka"])
    expect(got[2]?.info).toMatchObject({ builtin: false, pkg: "ayaka", author: "someone", version: "1.2.3" })
  })

  it("第三方包不能顶替经典", async () => {
    const warns: string[] = []
    const root = await webuiWith({
      "themes/classic": { "package.json": pkg({ id: "classic", name: "经典" }) },
      "plugins/fake": { "package.json": pkg({ id: "classic", name: "假经典" }) }
    })
    const got = await scanThemes(root, msg => warns.push(msg))
    expect(got.map(t => t.info.name)).toEqual(["经典"])
    expect(warns.join()).toContain("已被内置的经典主题占用")
  })

  it("声明了却不存在的样式表被忽略并警告，槽位解析成资源地址", async () => {
    const warns: string[] = []
    const root = await webuiWith({
      "plugins/ayaka": { "package.json": pkg({ id: "ayaka", name: "绫华", style: "gone.css", slots: { empty: "art/e.png" } }) }
    })
    const [theme] = await scanThemes(root, msg => warns.push(msg))
    expect(theme?.info.style).toBeUndefined()
    expect(theme?.info.slots.empty).toBe(`${themeBaseOf("ayaka")}/art/e.png`)
    expect(warns.join()).toContain("gone.css 不存在")
  })

  it("链接进来的包目录也扫得到", async () => {
    // 开发时常把仓库 junction 进 plugins/；readdir 把 junction 报成链接而不是目录
    const src = await webuiWith({ ayaka: { "package.json": pkg({ id: "ayaka", name: "绫华" }) } })
    const root = await webuiWith({ "plugins/.keep": { x: "" } })
    await symlink(join(src, "ayaka"), join(root, "plugins", "ayaka"), "junction")
    const got = await scanThemes(root, () => undefined)
    expect(got.map(t => t.info.id)).toEqual(["ayaka"])
  })
})

describe("readThemeAsset", () => {
  it("只给扩展名在表内的文件，package.json 与走出包外的取不到", async () => {
    const root = await webuiWith({
      "plugins/ayaka": { "package.json": pkg({ id: "ayaka", name: "绫华", style: "theme.css" }), "theme.css": ".a{}", "art/a.png": "PNG" },
      "plugins/secret.png": { "x": "" }
    })
    const [theme] = await scanThemes(root, () => undefined)
    if (theme === undefined) throw new Error("没扫到主题")
    expect((await readThemeAsset(theme, "package.json")).status).toBe(404)
    expect((await readThemeAsset(theme, "../secret.png/x")).status).toBe(404)
    expect((await readThemeAsset(theme, "art/missing.png")).status).toBe(404)
    const img = await readThemeAsset(theme, "art/a.png")
    expect(img.status === 200 && img.type).toBe("image/png")
  })

  it("入口样式表经过处理并包进层，其余样式表只处理地址", async () => {
    const root = await webuiWith({
      "plugins/ayaka": { "package.json": pkg({ id: "ayaka", name: "绫华", style: "theme.css" }), "theme.css": ".a{}", "part.css": ".b{}" }
    })
    const [theme] = await scanThemes(root, () => undefined)
    if (theme === undefined) throw new Error("没扫到主题")
    const entry = await readThemeAsset(theme, "theme.css")
    const part = await readThemeAsset(theme, "part.css")
    expect(entry.status === 200 && String(entry.body)).toContain("@layer theme")
    expect(part.status === 200 && String(part.body)).not.toContain("@layer theme")
  })
})

describe("内置主题", () => {
  // YUNZAI NG 是「主题能做的事」的完整样板：每个槽位、每枚导航图标、脚本与字体都用上了
  const webuiRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

  it("扫描时没有一条警告，YUNZAI NG 用满了全部槽位与导航图标", async () => {
    const warns: string[] = []
    const themes = await scanThemes(webuiRoot, msg => warns.push(msg))
    expect(warns).toEqual([])
    const pumpkin = themes.find(t => t.info.id === "pumpkin")
    expect(Object.keys(pumpkin?.info.slots ?? {}).sort()).toEqual([...SLOTS].sort())
    expect(Object.keys(pumpkin?.info.icons?.nav ?? {}).sort()).toEqual([...NAV_IDS].sort())
    expect(pumpkin?.info.script).toBe(`${themeBaseOf("pumpkin")}/theme.js`)
  })

  it("YUNZAI NG 引用的每个文件都取得到，样式表里的地址都留在包内", async () => {
    const themes = await scanThemes(webuiRoot, () => undefined)
    const pumpkin = themes.find(t => t.info.id === "pumpkin")
    if (pumpkin === undefined) throw new Error("没扫到 YUNZAI NG")
    const base = `${themeBaseOf("pumpkin")}/`
    const urls = new Set<string>()
    const collect = (v: unknown): void => {
      if (typeof v === "string" && v.startsWith(base)) urls.add(v.slice(base.length))
      else if (typeof v === "object" && v !== null) Object.values(v).forEach(collect)
    }
    collect(pumpkin.info)
    for (const file of urls) expect([file, (await readThemeAsset(pumpkin, file)).status]).toEqual([file, 200])
    const css = await readThemeAsset(pumpkin, "theme.css")
    if (css.status !== 200) throw new Error("样式表取不到")
    expect(css.warnings).toEqual([])
    for (const m of String(css.body).matchAll(/url\(\s*"?([^")]+)"?\s*\)/g)) {
      const ref = m[1] ?? ""
      expect(ref.startsWith(base)).toBe(true)
      expect((await readThemeAsset(pumpkin, ref.slice(base.length))).status).toBe(200)
    }
  })
})
