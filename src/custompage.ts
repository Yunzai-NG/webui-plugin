/** 扫描插件 webadapter/index.js，收集页面描述符并挂载静态资源。 */
/* eslint-disable jsdoc/require-jsdoc -- 页面描述符为内部传输数据结构。 */
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export interface CustomPage { id: string; title: string; icon?: string; src?: string; style?: string; script?: string; plugin: string; provider?: string; url?: string }

function safe(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..") }

/** 扫描插件目录并挂载自定义页面资源；坏插件隔离，不影响主面板。 */
export async function mountCustomPages(ctx: { static(path: string, dir: string): unknown; route(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: (req: { body: unknown; params: Record<string, string> }) => unknown): unknown; logger: { warn(msg: string): void }; app: { paths: { config: string } } }, pluginsDir: string): Promise<void> {
    const pages: CustomPage[] = []
    let dirs: string[] = []
    try { dirs = (await readdir(pluginsDir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name) } catch { return }
    for (const plugin of dirs) {
        const dir = join(pluginsDir, plugin, "webadapter")
        const entry = join(dir, "index.js")
        if (!existsSync(entry)) continue
        try {
            const mod = await import(pathToFileURL(entry).href)
            const def = mod.default ?? mod.page ?? mod
            const list = Array.isArray(def) ? def : (Array.isArray(def?.pages) ? def.pages : def?.page ? [def.page] : [])
            const init = typeof mod.init === "function" ? mod.init : undefined
            if (init) await init({
                pluginName: plugin,
                pluginDir: dir,
                configDir: ctx.app.paths.config,
                registerPage: (page: Omit<CustomPage, "plugin">) => pages.push({ ...page, plugin }),
                registerPages: (items: Omit<CustomPage, "plugin">[]) => items.forEach(page => pages.push({ ...page, plugin })),
                registerApi: (method: "GET" | "POST" | "PUT" | "DELETE", apiPath: string, handler: (req: { body: unknown; params: Record<string, string> }) => unknown) => {
                    ctx.route(method, `/custom/${plugin}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`, handler)
                }
            })
            for (const item of list) if (item && safe(item.id) && typeof item.title === "string") pages.push({ ...item, plugin, provider: item.provider ?? plugin })
            ctx.static(`custom/${plugin}`, dir)
        } catch (error) { ctx.logger.warn(`自定义页面 ${plugin} 加载失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const page of pages) {
        if (page.src && safe(page.src)) page.url = `/plugin/webui/custom/${page.plugin}/${page.src}`
        if (page.style && !safe(page.style)) delete page.style
        if (page.script && !safe(page.script)) delete page.script
    }
    ctx.route("GET", "/custom-pages", () => ({ pages }))
}