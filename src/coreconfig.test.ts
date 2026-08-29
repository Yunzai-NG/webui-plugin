/**
 * 读内核配置那两项的用例
 *
 * **这一处的退回值决定了两件不同性质的事**，故四种「读不到」的情形都要立断言：
 *
 *   - `mirror` 取不到 → 直连。至多是慢或失败，而失败带明确的网络错误。
 *   - `readonly` 取不到 → **按 false**。按 true 会让一个正常实例的商店与配置全线拒写，
 *     且给出一句与事实不符的理由；而只读模式本是「防手滑」而非防入侵 —— 两条路由照旧
 *     要令牌。这一条是刻意的取舍，故用例明写它。
 *
 * 四种情形在真实文件上难以复现（改坏 yaml、删掉键、把键写成错的类型），这正是把取值
 * 规则抽成纯函数 `settingsFrom` 的理由。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseYaml } from "@yunzai-ng/core"
import { readCoreSettings, settingsFrom } from "./coreconfig.js"

/** 用完即删的临时目录 */
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * 造一个临时配置目录，并写进一份 yaml
 * @param yaml 文件内容；不给则不建文件
 * @returns 配置目录绝对路径
 */
async function configDir(yaml?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yzng-coreconf-"))
  dirs.push(dir)
  if (yaml !== undefined) await writeFile(join(dir, "yunzai.yaml"), yaml, "utf8")
  return dir
}

/** 记下 debug 的读取器 */
function reader(dir: string): { deps: Parameters<typeof readCoreSettings>[0]; debugs: string[] } {
  const debugs: string[] = []
  return {
    deps: { configDir: dir, configName: "yunzai", parse: parseYaml, debug: m => void debugs.push(m) },
    debugs
  }
}

describe("settingsFrom", () => {
  it("两项都取得到", () => {
    expect(settingsFrom({ market: { mirror: "https://gh-proxy.org/" }, server: { readonly: true } })).toEqual({
      mirror: "https://gh-proxy.org/",
      readonly: true
    })
  })

  it("镜像去首尾空白 —— 使用者粘贴地址时常带一个换行", () => {
    expect(settingsFrom({ market: { mirror: "  https://x/  " } }).mirror).toBe("https://x/")
  })

  it("整份文档不是对象时给默认值", () => {
    expect(settingsFrom(undefined)).toEqual({ mirror: "", readonly: false })
    expect(settingsFrom("字符串")).toEqual({ mirror: "", readonly: false })
    expect(settingsFrom([1, 2])).toEqual({ mirror: "", readonly: false })
  })

  it("缺 market 段时直连", () => {
    expect(settingsFrom({ server: { readonly: true } }).mirror).toBe("")
  })

  it("缺 server 段时**按非只读**，理由见文件头", () => {
    expect(settingsFrom({ market: { mirror: "https://x/" } }).readonly).toBe(false)
  })

  it("mirror 写成非字符串时直连", () => {
    expect(settingsFrom({ market: { mirror: 123 } }).mirror).toBe("")
  })

  it("readonly 只认确凿的 true —— 字符串 \"true\" 不算，与内核 requireWritable 同判据", () => {
    expect(settingsFrom({ server: { readonly: "true" } }).readonly).toBe(false)
    expect(settingsFrom({ server: { readonly: 1 } }).readonly).toBe(false)
    expect(settingsFrom({ server: { readonly: true } }).readonly).toBe(true)
  })
})

describe("readCoreSettings", () => {
  it("读得到时给出两项", async () => {
    const dir = await configDir("market:\n  mirror: https://gh-proxy.org/\nserver:\n  readonly: true\n")
    expect(await readCoreSettings(reader(dir).deps)).toEqual({ mirror: "https://gh-proxy.org/", readonly: true })
  })

  it("文件不存在时给默认值，并记一条 debug 说明按什么处置", async () => {
    const dir = await configDir()
    const { deps, debugs } = reader(dir)
    expect(await readCoreSettings(deps)).toEqual({ mirror: "", readonly: false })
    expect(debugs.join()).toMatch(/按直连处置，只读模式按未开启处置/)
  })

  it("yaml 写坏时给默认值而非抛错 —— 调用点是「使用者点了安装」，不该收到一句读配置失败", async () => {
    const dir = await configDir("market:\n  mirror: [unclosed\n")
    const { deps, debugs } = reader(dir)
    expect(await readCoreSettings(deps)).toEqual({ mirror: "", readonly: false })
    expect(debugs.join()).toMatch(/解析失败/)
  })

  it("空文件给默认值", async () => {
    const dir = await configDir("")
    expect(await readCoreSettings(reader(dir).deps)).toEqual({ mirror: "", readonly: false })
  })

  it("只有 server.readonly 一项时，镜像仍是直连", async () => {
    const dir = await configDir("server:\n  readonly: true\n")
    expect(await readCoreSettings(reader(dir).deps)).toEqual({ mirror: "", readonly: true })
  })
})
