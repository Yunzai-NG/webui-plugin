import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { startCollector, type CollectHost } from "./msgcollect.js"

let dir = ""

afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true })
  dir = ""
})

/**
 * 造一个采集器宿主
 * @returns 宿主与登记到的监听
 */
async function host(): Promise<{ host: CollectHost; handlers: Record<string, (...args: unknown[]) => void> }> {
  dir = await mkdtemp(join(tmpdir(), "yzng-msgcollect-"))
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  return {
    handlers,
    host: {
      dataDir: dir,
      logger: { warn: () => undefined, debug: () => undefined },
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        handlers[ev] = fn
        return () => undefined
      }
    } as unknown as CollectHost
  }
}

describe("startCollector 落盘", () => {
  it("面板读过一次统计之后，停机照样写出文件", async () => {
    const { host: h, handlers } = await host()
    const collector = await startCollector(h)
    handlers["message"]?.({
      time: Date.now(),
      scene: "group",
      group: { gid: "1", name: "测试群" },
      sender: { uid: "u1", name: "a" },
      message: [{ type: "text", text: "hi" }],
      platform: "qq",
      selfId: "10000"
    })
    // 概览与统计页的读接口都走 read()
    collector.read()
    await collector.stop()
    const saved = JSON.parse(await readFile(join(dir, "msgstats.json"), "utf8")) as { days: Record<string, unknown> }
    expect(Object.keys(saved.days)).toHaveLength(1)
  })
})
