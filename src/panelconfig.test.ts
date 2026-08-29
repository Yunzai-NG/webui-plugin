/**
 * 模块职责：`panelconfig.ts` 的用例 —— 声明校验、默认值、归一化、读写落盘
 * 依赖方向：测试文件，依赖 panelconfig 与 panelscan 的类型
 * 生命周期：涉及落盘的用例各造一个临时数据目录，afterEach 删除
 * 注意事项：**本文件里的每一条都在钉「算错了不报错」的那类缺陷。** 默认值填漏一处、类型
 *          放过一个坏值、多出来的键当成错而拒掉整次保存 —— 三者都不抛异常，只表现为
 *          「面板上显示的数与包实际用的数不是一个」或「保存按钮点了没反应」。
 *
 *          **真的写文件。** 先写临时名再 rename 这一路只有落到真文件系统上才走得完，
 *          而它正是「使用者的配置无声无息回到默认值」那类事故的防线。
 */
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SchemaDescriptor } from "@yunzai-ng/types"
import {
  CONFIG_DIR,
  PanelConfigStore,
  checkConfigSchema,
  configFileOf,
  configKeyOf,
  defaultsOf,
  normalizeValue
} from "./panelconfig.js"
import type { PanelPackage } from "./panelscan.js"

/** 用例造出的临时目录 */
let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })))
  dirs = []
})

/**
 * 造一个临时数据目录
 * @returns 目录绝对路径
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yzng-panelconfig-"))
  dirs.push(dir)
  return dir
}

/** 用例里反复用到的一份声明：两层嵌套、四种类型、一个枚举 */
const SCHEMA: SchemaDescriptor = {
  type: "object",
  properties: {
    redis: {
      type: "object",
      properties: {
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "number", default: 6379 }
      }
    },
    enabled: { type: "boolean", default: true },
    mode: { type: "enum", default: "fast", enum: [{ value: "fast" }, { value: "slow" }] },
    tags: { type: "array", items: { type: "string" }, default: [] },
    probes: { type: "record", values: { type: "string" }, default: {} },
    extra: { type: "unknown" },
    nickname: { type: "string" }
  }
}

/**
 * 造一个包
 * @param dataDir 数据目录（只为凑齐字段，store 用的是自己那份）
 * @param config 配置声明
 * @returns 包
 */
function packageOf(dataDir: string, config?: SchemaDescriptor): PanelPackage {
  return {
    owner: "panels",
    name: "demo",
    dir: join(dataDir, "plugins", "demo"),
    needsInstall: false,
    ...(config === undefined ? {} : { config })
  }
}

/**
 * 造一个记录用的日志器
 * @returns 日志器与记下的行
 */
function loggerOf(): { logger: { warn(msg: string): void; debug(msg: string): void }; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    logger: {
      warn: msg => void lines.push(`warn ${msg}`),
      debug: msg => void lines.push(`debug ${msg}`)
    }
  }
}

describe("checkConfigSchema", () => {
  it("认下一份齐备的声明", () => {
    const got = checkConfigSchema(SCHEMA)
    expect(got.ok).toBe(true)
  })

  it("顶层不是 object 的不认：表单按顶层 properties 分区渲染，给个 string 画不出任何东西", () => {
    const got = checkConfigSchema({ type: "string" })
    expect(got).toEqual({ ok: false, reason: expect.stringContaining("type 须是 object") })
  })

  it("不是对象的不认", () => {
    expect(checkConfigSchema("redis://x").ok).toBe(false)
    expect(checkConfigSchema(undefined).ok).toBe(false)
  })

  it("缺 properties 的不认", () => {
    const got = checkConfigSchema({ type: "object" })
    expect(got).toEqual({ ok: false, reason: expect.stringContaining("缺少 properties") })
  })

  it("**properties 为空的不算声明了配置** —— 那时按钮点开确实是空表单，与没声明无从区分", () => {
    const got = checkConfigSchema({ type: "object", properties: {} })
    expect(got).toEqual({ ok: false, reason: expect.stringContaining("是空的") })
  })

  it("子项的 type 不认得时给出是哪个字段", () => {
    const got = checkConfigSchema({ type: "object", properties: { port: { type: "int" } } })
    expect(got).toEqual({ ok: false, reason: expect.stringContaining("配置字段 port") })
  })

  it("嵌套 object 缺 properties 时逐层报出路径", () => {
    const got = checkConfigSchema({
      type: "object",
      properties: { redis: { type: "object", properties: { auth: { type: "object" } } } }
    })
    expect(got).toEqual({ ok: false, reason: expect.stringContaining("redis.auth") })
  })

  it("enum 没有候选项的不认：那样的下拉一个选项都没有", () => {
    const got = checkConfigSchema({ type: "object", properties: { mode: { type: "enum", enum: [] } } })
    expect(got).toEqual({ ok: false, reason: expect.stringContaining("非空的 enum") })
  })

  it("enum 候选项的 value 不是标量的不认", () => {
    const got = checkConfigSchema({
      type: "object",
      properties: { mode: { type: "enum", enum: [{ value: { a: 1 } }] } }
    })
    expect(got).toEqual({ ok: false, reason: expect.stringContaining("value 是字符串") })
  })

  it("array 与 record 的元素声明也要合法", () => {
    expect(checkConfigSchema({ type: "object", properties: { a: { type: "array", items: { type: "x" } } } }).ok).toBe(
      false
    )
    expect(checkConfigSchema({ type: "object", properties: { a: { type: "record", values: { type: "x" } } } }).ok).toBe(
      false
    )
  })

  it("array 与 record 不给元素声明也放行：那意味着元素不限类型", () => {
    expect(checkConfigSchema({ type: "object", properties: { a: { type: "array" } } }).ok).toBe(true)
    expect(checkConfigSchema({ type: "object", properties: { a: { type: "record" } } }).ok).toBe(true)
  })
})

describe("defaultsOf", () => {
  it("逐项取 default，嵌套的按层给出", () => {
    expect(defaultsOf(SCHEMA)).toEqual({
      redis: { host: "127.0.0.1", port: 6379 },
      enabled: true,
      mode: "fast",
      tags: [],
      probes: {}
    })
  })

  it("**没有默认值的字段不出现**，而不是给个 null 占位 —— null 会在下次保存时被当成使用者选了空值", () => {
    const got = defaultsOf(SCHEMA)
    expect(Object.hasOwn(got, "nickname")).toBe(false)
    expect(Object.hasOwn(got, "extra")).toBe(false)
  })

  it("**object 恒给出一个对象**，哪怕子字段一个默认值都没有 —— 缺了它表单的就地写入会静默放弃", () => {
    const got = defaultsOf({
      type: "object",
      properties: { redis: { type: "object", properties: { host: { type: "string" } } } }
    })
    expect(got).toEqual({ redis: {} })
  })

  it("默认值是拷贝：改返回值不会污染声明，否则第二个包读到的是第一个包改过的那份", () => {
    const schema: SchemaDescriptor = { type: "object", properties: { tags: { type: "array", default: ["a"] } } }
    const first = defaultsOf(schema) as { tags: string[] }
    first.tags.push("b")
    expect(defaultsOf(schema)).toEqual({ tags: ["a"] })
  })
})

describe("normalizeValue", () => {
  it("空值时整份取默认", () => {
    const { value, issues } = normalizeValue(SCHEMA, undefined)
    expect(value).toEqual(defaultsOf(SCHEMA))
    expect(issues).toEqual([])
  })

  it("给了的照收，没给的取默认", () => {
    const { value } = normalizeValue(SCHEMA, { redis: { host: "10.0.0.2" }, nickname: "本机" })
    expect(value.redis).toEqual({ host: "10.0.0.2", port: 6379 })
    expect(value.nickname).toBe("本机")
    expect(value.enabled).toBe(true)
  })

  it("**类型不符时退回默认值并记一条 error**，不把坏值留给包的 node 侧", () => {
    const { value, issues } = normalizeValue(SCHEMA, { redis: { port: "6379" } })
    expect((value.redis as { port: number }).port).toBe(6379)
    expect(issues).toEqual([{ path: "redis.port", message: "须是数字，收到的是文本", severity: "error" }])
  })

  it("NaN 与 Infinity 不算数字：它们进 JSON 会变成 null", () => {
    expect(normalizeValue(SCHEMA, { redis: { port: Number.NaN } }).issues[0]?.severity).toBe("error")
  })

  it("布尔与文本各自认自己的类型", () => {
    const { issues } = normalizeValue(SCHEMA, { enabled: "true", nickname: 3 })
    expect(issues.map(item => item.path).sort()).toEqual(["enabled", "nickname"])
  })

  it("枚举不在候选里时报出可选项", () => {
    const { value, issues } = normalizeValue(SCHEMA, { mode: "turbo" })
    expect(value.mode).toBe("fast")
    expect(issues[0]?.message).toContain("不在候选项里")
  })

  it("**多出来的键丢掉但只记 warn** —— 记成 error 会让一个早已删掉的字段挡住一次正当的保存", () => {
    const { value, issues } = normalizeValue(SCHEMA, { legacy: 1 })
    expect(Object.hasOwn(value, "legacy")).toBe(false)
    expect(issues).toEqual([{ path: "legacy", message: "这个字段不在配置声明里，已丢弃", severity: "warn" }])
  })

  it("嵌套里多出来的键同样按点号路径报出", () => {
    const { issues } = normalizeValue(SCHEMA, { redis: { db: 3 } })
    expect(issues).toEqual([expect.objectContaining({ path: "redis.db", severity: "warn" })])
  })

  it("列表逐项查元素类型，并说明是第几项", () => {
    const { value, issues } = normalizeValue(SCHEMA, { tags: ["a", 2] })
    expect(value.tags).toEqual([])
    expect(issues[0]).toEqual({ path: "tags", message: "第 2 项须是文本，收到的是数字", severity: "error" })
  })

  it("键值对逐个查值的类型，并说明是哪个键", () => {
    const { issues } = normalizeValue(SCHEMA, { probes: { 主页: 1 } })
    expect(issues[0]?.message).toBe("键 主页 的值须是文本，收到的是数字")
  })

  it("`unknown` 放行任何东西：那正是它的意思", () => {
    const { value, issues } = normalizeValue(SCHEMA, { extra: { deep: [1, "2", null] } })
    expect(value.extra).toEqual({ deep: [1, "2", null] })
    expect(issues).toEqual([])
  })

  it("该是对象的地方给了标量时报出，且其余字段照常取默认", () => {
    const { value, issues } = normalizeValue(SCHEMA, { redis: 3 })
    expect(value.redis).toEqual({ host: "127.0.0.1", port: 6379 })
    expect(issues[0]).toEqual({ path: "redis", message: "须是一个对象，收到的是数字", severity: "error" })
  })
})

describe("configFileOf 与 configKeyOf", () => {
  it("落在数据目录下的 panelconfig/<归属>/<包名>.json", () => {
    expect(configFileOf("/data/webui", "panels", "hardware")).toBe(
      join("/data/webui", CONFIG_DIR, "panels", "hardware.json")
    )
  })

  it("包键与浏览器侧、清单端点那两处同一条规则", () => {
    expect(configKeyOf({ owner: "panels", name: "hardware", dir: "/x", needsInstall: false })).toBe("panels/hardware")
  })
})

describe("PanelConfigStore", () => {
  it("还没配置过时给默认值，且不出声：文件不存在是常态", async () => {
    const dir = await tempDir()
    const { logger, lines } = loggerOf()
    const store = new PanelConfigStore(dir, logger)
    expect(await store.ensure(packageOf(dir, SCHEMA))).toEqual(defaultsOf(SCHEMA))
    expect(lines.filter(line => line.startsWith("warn"))).toEqual([])
  })

  it("没声明配置的包给空对象，save 明确拒掉", async () => {
    const dir = await tempDir()
    const store = new PanelConfigStore(dir, loggerOf().logger)
    const pkg = packageOf(dir)
    expect(await store.ensure(pkg)).toEqual({})
    const done = await store.save(pkg, { a: 1 })
    expect(done.ok).toBe(false)
  })

  it("**保存之后 get() 立刻是新值**，这正是「改完下一次请求即生效」", async () => {
    const dir = await tempDir()
    const store = new PanelConfigStore(dir, loggerOf().logger)
    const pkg = packageOf(dir, SCHEMA)
    await store.ensure(pkg)
    expect((store.get("panels/demo").redis as { port: number }).port).toBe(6379)

    const done = await store.save(pkg, { redis: { host: "10.0.0.9", port: 6380 } })
    expect(done.ok).toBe(true)
    expect(store.get("panels/demo").redis).toEqual({ host: "10.0.0.9", port: 6380 })
  })

  it("落盘的是一份能读回来的 JSON，且新起的 store 读得到同一份", async () => {
    const dir = await tempDir()
    const store = new PanelConfigStore(dir, loggerOf().logger)
    const pkg = packageOf(dir, SCHEMA)
    await store.save(pkg, { nickname: "甲机" })

    const file = configFileOf(dir, "panels", "demo")
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ nickname: "甲机" })

    const again = new PanelConfigStore(dir, loggerOf().logger)
    expect((await again.ensure(pkg)).nickname).toBe("甲机")
  })

  it("**类型不符时一个字节都不写**：半份写进去的配置比整份拒掉难查得多", async () => {
    const dir = await tempDir()
    const store = new PanelConfigStore(dir, loggerOf().logger)
    const pkg = packageOf(dir, SCHEMA)
    const done = await store.save(pkg, { redis: { port: "6379" } })
    expect(done.ok).toBe(false)
    if (!done.ok) expect(done.issues[0]?.path).toBe("redis.port")
    await expect(readFile(configFileOf(dir, "panels", "demo"), "utf8")).rejects.toThrow()
  })

  it("只有 warn 时照常保存，并把那几条一并交回去", async () => {
    const dir = await tempDir()
    const store = new PanelConfigStore(dir, loggerOf().logger)
    const done = await store.save(packageOf(dir, SCHEMA), { legacy: 1, nickname: "乙机" })
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.value.nickname).toBe("乙机")
      expect(done.issues.map(item => item.severity)).toEqual(["warn"])
    }
  })

  it("**手改坏了一个字段时修好并出声，不报废整份配置**", async () => {
    const dir = await tempDir()
    const { logger, lines } = loggerOf()
    const file = configFileOf(dir, "panels", "demo")
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(file, JSON.stringify({ redis: { host: "10.0.0.3", port: "6379" } }), "utf8")

    const store = new PanelConfigStore(dir, logger)
    const value = await store.ensure(packageOf(dir, SCHEMA))
    expect(value.redis).toEqual({ host: "10.0.0.3", port: 6379 })
    expect(lines.some(line => line.includes("redis.port"))).toBe(true)
  })

  it("文件不是 JSON 时用默认值并出声 —— 与「还没配置过」表现相同，故必须说一句", async () => {
    const dir = await tempDir()
    const { logger, lines } = loggerOf()
    const file = configFileOf(dir, "panels", "demo")
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(file, "{ 半份", "utf8")

    const store = new PanelConfigStore(dir, logger)
    expect(await store.ensure(packageOf(dir, SCHEMA))).toEqual(defaultsOf(SCHEMA))
    expect(lines.some(line => line.includes("读不动"))).toBe(true)
  })

  it("**恢复默认值是删文件，不是写一份等于默认值的文件** —— 后者会钉在旧默认值上", async () => {
    const dir = await tempDir()
    const store = new PanelConfigStore(dir, loggerOf().logger)
    const pkg = packageOf(dir, SCHEMA)
    await store.save(pkg, { nickname: "丙机" })

    expect(await store.reset(pkg)).toEqual(defaultsOf(SCHEMA))
    expect(store.get("panels/demo").nickname).toBeUndefined()
    await expect(readFile(configFileOf(dir, "panels", "demo"), "utf8")).rejects.toThrow()
  })
})
