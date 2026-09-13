/**
 * 模块职责：`custompage.ts` 的用例 —— 每插件一页、只读接口、路径校验、失败隔离
 * 依赖方向：测试文件，只依赖 custompage
 * 生命周期：每个用例造一个临时 plugins 目录，afterEach 删除
 * 注意事项：**真的写文件、真的 `import()`。** 这一路最容易错的地方是「绝对路径没转成 file:// URL」，
 *          而那只在 Windows 上犯 —— 用替身替掉 import 恰好把它遮住。
 *
 *          入口文件名被 `custompage.ts` 硬编码为 `index.js`，故不能像 panelserver 的用例那样
 *          靠 `.mjs` 让 node 认 ESM，**得在插件目录里放一份 `{"type":"module"}` 的 package.json** ——
 *          临时目录不在任何 ESM 包之下，缺了它 `export default` 就是一条语法错误，而那条错误
 *          与本文件要验的东西毫无关系。
 *
 *          **每个用例的插件目录名都不同。** ESM 的模块缓存按 URL 记，同名路径改了内容再 import
 *          仍是上一次那份 —— 这会让「改坏它应该失败」那类用例莫名通过。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { mountCustomPages, type CustomPage } from "./custompage.js"

/** 用例造出的临时目录 */
let dirs: string[] = []

/** 每个用例一个不同的插件目录名，避开 ESM 模块缓存 */
let seq = 0

afterEach(async () => {
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })))
  dirs = []
})

/** 记下的日志行、注册过的路由与静态挂载 */
interface Recorder {
  /** 全部警告 */
  warns: string[]
  /** 注册过的路由路径 */
  routes: string[]
  /** 路径 → 处理函数 */
  handlers: Map<string, (req: { params: Record<string, string> }) => unknown>
  /** 静态挂载的前缀 */
  statics: string[]
}

/**
 * 造一个记录器
 * @returns 记录器
 */
function recorder(): Recorder {
  return { warns: [], routes: [], handlers: new Map(), statics: [] }
}

/**
 * 造一个记录用的上下文
 * @param rec 记录器
 * @returns 上下文
 */
function ctxOf(rec: Recorder): Parameters<typeof mountCustomPages>[0] {
  return {
    static: (path, _dir) => {
      rec.statics.push(path)
      return undefined
    },
    route: (_method, path, handler) => {
      rec.routes.push(path)
      rec.handlers.set(path, handler)
      return undefined
    },
    logger: { warn: msg => rec.warns.push(msg) },
    app: { paths: { config: "/tmp/yzng-config" } }
  }
}

/**
 * 造一个 plugins 目录，其下若干插件各带一个 `webadapter/`
 * @param plugins 插件名 → `webadapter/index.js` 的内容；值为 undefined 表示不建该文件
 * @returns plugins 目录绝对路径
 */
async function makePlugins(plugins: Record<string, string | undefined>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yzng-custompage-"))
  dirs.push(root)
  for (const [name, source] of Object.entries(plugins)) {
    const dir = join(root, name, "webadapter")
    await mkdir(dir, { recursive: true })
    // 临时目录不在任何 ESM 包之下，缺这份 package.json 时 export 是语法错，见文件头
    await writeFile(join(root, name, "package.json"), `{"type":"module"}`, "utf8")
    if (source !== undefined) await writeFile(join(dir, "index.js"), source, "utf8")
  }
  return root
}

/**
 * 取清单端点的返回
 * @param rec 记录器
 * @returns 页面数组
 */
function pagesOf(rec: Recorder): CustomPage[] {
  const handler = rec.handlers.get("/custom-pages")
  expect(handler).toBeDefined()
  return (handler?.({ params: {} }) as { pages: CustomPage[] }).pages
}

/**
 * 造一个本用例专用的插件名
 * @param hint 便于辨认的前缀
 * @returns 插件名
 */
function nameOf(hint: string): string {
  return `${hint}-${++seq}`
}

describe("mountCustomPages", () => {
  it("默认导出的描述符即可注册一页，入口缺省为 index.html", async () => {
    const rec = recorder()
    const plug = nameOf("demo")
    const root = await makePlugins({ [plug]: `export default { title: "统计", sub: "本月用量" }` })

    await mountCustomPages(ctxOf(rec), root)
    const pages = pagesOf(rec)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      id: plug,
      title: "统计",
      sub: "本月用量",
      provider: plug,
      url: `/plugin/webui/custom/${plug}/index.html`
    })
    expect(rec.statics).toContain(`custom/${plug}`)
  })

  it("**每插件只取第一页**，多注册的一律警告后丢弃 —— 否则一个插件能占满整条导航", async () => {
    const rec = recorder()
    const plug = nameOf("greedy")
    const root = await makePlugins({
      [plug]: `export function init(ctx) {
        ctx.registerPage({ title: "第一页" })
        ctx.registerPage({ title: "第二页" })
        ctx.registerPage({ title: "第三页" })
      }`
    })

    await mountCustomPages(ctxOf(rec), root)
    const pages = pagesOf(rec)

    expect(pages).toHaveLength(1)
    expect(pages[0]?.title).toBe("第一页")
    expect(rec.warns.filter(line => line.includes("只能注册一个页面"))).toHaveLength(2)
  })

  it("页面标识取插件目录名，不收插件自报的 id —— 两家都叫 stats 时前端会串页", async () => {
    const rec = recorder()
    const a = nameOf("alpha")
    const b = nameOf("beta")
    const root = await makePlugins({
      [a]: `export default { id: "stats", title: "甲" }`,
      [b]: `export default { id: "stats", title: "乙" }`
    })

    await mountCustomPages(ctxOf(rec), root)
    const ids = pagesOf(rec).map(page => page.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([a, b]))
  })

  it("registerApi 落在本插件前缀之下，且只注册 GET", async () => {
    const rec = recorder()
    const plug = nameOf("api")
    const root = await makePlugins({
      [plug]: `export function init(ctx) { ctx.registerApi("stats", () => ({ n: 1 })) }`
    })

    await mountCustomPages(ctxOf(rec), root)

    expect(rec.routes).toContain(`/custom/${plug}/api/stats`)
    const handler = rec.handlers.get(`/custom/${plug}/api/stats`)
    expect(handler?.({ params: {} })).toEqual({ n: 1 })
  })

  it("**挡下带 `..` 的接口路径** —— 那是路由穿越，一个插件会接管另一个插件的接口", async () => {
    const rec = recorder()
    const plug = nameOf("evil")
    const root = await makePlugins({
      [plug]: `export function init(ctx) { ctx.registerApi("../../api/config/yunzai", () => 1) }`
    })

    await mountCustomPages(ctxOf(rec), root)

    expect(rec.routes.some(path => path.includes(".."))).toBe(false)
    expect(rec.warns.some(line => line.includes("不合法"))).toBe(true)
  })

  it("挡下越界的入口文件名，不挂那一页", async () => {
    const rec = recorder()
    const plug = nameOf("escape")
    const root = await makePlugins({ [plug]: `export default { src: "../../../etc/passwd" }` })

    await mountCustomPages(ctxOf(rec), root)

    expect(pagesOf(rec)).toHaveLength(0)
    expect(rec.warns.some(line => line.includes("相对文件路径"))).toBe(true)
  })

  it("入口抛错只废掉那一个插件，其余照常挂上", async () => {
    const rec = recorder()
    const bad = nameOf("bad")
    const good = nameOf("good")
    const root = await makePlugins({
      [bad]: `throw new Error("我坏了")`,
      [good]: `export default { title: "好的" }`
    })

    await mountCustomPages(ctxOf(rec), root)
    const pages = pagesOf(rec)

    expect(pages.map(page => page.id)).toEqual([good])
    expect(rec.warns.some(line => line.includes("我坏了"))).toBe(true)
  })

  it("只有 index.html 而 index.js 为空也算一页 —— 纯静态页面不该被迫写 node 侧", async () => {
    const rec = recorder()
    const plug = nameOf("static")
    const root = await makePlugins({ [plug]: `` })

    await mountCustomPages(ctxOf(rec), root)
    const pages = pagesOf(rec)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ id: plug, title: plug, provider: plug })
  })

  it("没有 webadapter/index.js 的插件不出现在清单里", async () => {
    const rec = recorder()
    const plug = nameOf("plain")
    const root = await makePlugins({ [plug]: undefined })

    await mountCustomPages(ctxOf(rec), root)

    expect(pagesOf(rec)).toHaveLength(0)
    expect(rec.statics).toHaveLength(0)
  })

  it("插件自报的图标经解析进描述符，只留几何、丢掉上色属性", async () => {
    const rec = recorder()
    const plug = nameOf("icon")
    const root = await makePlugins({
      [plug]: `export default {
        title: "统计",
        icon: '<svg viewBox="0 0 24 24" fill="#333"><path d="M4 20V10" stroke="#f00"/><circle cx="12" cy="12" r="3"/></svg>'
      }`
    })

    await mountCustomPages(ctxOf(rec), root)
    const page = pagesOf(rec)[0]

    expect(page?.icon).toEqual([
      { tag: "path", attrs: { d: "M4 20V10" } },
      { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } }
    ])
    // 上色一概不留：留着 `fill="#333"`，深色主题下它就是一团黑
    expect(JSON.stringify(page?.icon)).not.toContain("#")
    expect(rec.warns).toHaveLength(0)
  })

  it("图标不可用只是回落到默认图标，那一页照常注册 —— 与入口写错不是一类事", async () => {
    const rec = recorder()
    const plug = nameOf("badicon")
    const root = await makePlugins({
      [plug]: `export default { title: "统计", icon: '<svg><script>alert(1)</script></svg>' }`
    })

    await mountCustomPages(ctxOf(rec), root)
    const pages = pagesOf(rec)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ id: plug, title: "统计" })
    expect(pages[0]?.icon).toBeUndefined()
    expect(rec.warns.some(line => line.includes("图标无法解析"))).toBe(true)
  })

  it("plugins 目录不存在时照样挂上清单端点，返回空数组 —— 全新安装尚未建该目录", async () => {
    const rec = recorder()

    await mountCustomPages(ctxOf(rec), join(tmpdir(), `yzng-not-here-${++seq}`))

    expect(pagesOf(rec)).toEqual([])
    expect(rec.warns).toHaveLength(0)
  })
})
