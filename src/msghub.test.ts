/**
 * 模块职责：钉住概览摘要 `readBrief` 的口径
 * 依赖方向：只依赖 msghub 与 msgstats 的纯函数
 * 生命周期：测试
 * 注意事项：**时刻用假时钟钉住。** 逐时那 24 格以「此刻」为右端，跑到整点边上时两次取 `Date.now()`
 *          会落在不同的小时里，用例时红时绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BRIEF_PEERS, clearStatsReader, readBrief, setStatsReader } from "./msghub.js"
import { dayKey, emptyTally, hourKey, type StatsDoc, type Tally } from "./msgstats.js"

/** 本地时区下的某日 15:20，避开零点与整点 */
const NOW = new Date(2026, 9, 17, 15, 20, 0).getTime()

/**
 * 只填条数的计数
 * @param messages 条数
 * @returns 计数
 */
const t = (messages: number): Tally => ({ ...emptyTally(), messages })

/**
 * 一份今天有三个会话、当前小时有收发的文档
 * @returns 文档
 */
function docOfToday(): StatsDoc {
  const day = dayKey(NOW)
  const hour = hourKey(NOW)
  return {
    version: 2,
    days: {
      [day]: {
        day,
        peers: {
          "group:1": { peer: "group:1", name: "甲群", scene: "group", recv: t(30), sent: t(5) },
          "group:2": { peer: "group:2", name: "乙群", scene: "group", recv: t(3), sent: t(1) },
          "group:3": { peer: "group:3", name: "丙群", scene: "group", recv: t(1), sent: t(0) },
          "private:9": { peer: "private:9", name: "某人", scene: "private", recv: t(8), sent: t(8) }
        },
        hours: { [hour]: { recv: t(42), sent: t(14) } }
      }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  clearStatsReader()
  vi.useRealTimers()
})

describe("readBrief", () => {
  it("采集器没起来时如实说没在跑，24 格全为 0 —— 不拿一排 0 冒充「没人说话」", () => {
    const brief = readBrief()
    expect(brief.running).toBe(false)
    expect(brief.hours).toHaveLength(24)
    expect(brief.hours.every(slot => slot.recv === 0 && slot.sent === 0)).toBe(true)
    expect(brief.peers).toEqual([])
  })

  it("逐时 24 格，末格是当前小时", () => {
    setStatsReader(docOfToday)
    const brief = readBrief()
    expect(brief.running).toBe(true)
    expect(brief.hours).toHaveLength(24)
    expect(brief.hours[23]).toMatchObject({ recv: 42, sent: 14 })
    expect(brief.last24.recv.messages).toBe(42)
  })

  it("今日合计取会话那一层，与逐时口径分开", () => {
    setStatsReader(docOfToday)
    const brief = readBrief()
    expect(brief.today.recv.messages).toBe(30 + 3 + 1 + 8)
    expect(brief.today.sent.messages).toBe(5 + 1 + 0 + 8)
  })

  it(`会话按收发总条数降序，只取前 ${BRIEF_PEERS} 个`, () => {
    setStatsReader(docOfToday)
    expect(readBrief().peers).toEqual([
      { name: "甲群", scene: "group", messages: 35 },
      { name: "某人", scene: "private", messages: 16 },
      { name: "乙群", scene: "group", messages: 4 }
    ])
  })
})
