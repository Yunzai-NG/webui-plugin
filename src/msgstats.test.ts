/**
 * 用例意图：钉住消息统计里「算错了也照样跑」的那几处 —— 天界按本地时区切、跨天翻桶、
 *          裁剪边界、空天补 0、坏文档不炸。这些错掉的表现只是数字偏了，没有任何报错。
 * 覆盖边界：本地时区 vs UTC 的凌晨、保留期的首尾两天、区间写反、名字覆盖方向、
 *          收发标识必须拼得一致（否则同一个群裂成两半）。
 */
import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HOUR_KEEP_DAYS,
  KEEP_DAYS,
  StatsBuckets,
  aggregate,
  aggregateHours,
  dayKey,
  emptyTally,
  parseStatsDoc,
  shiftDay,
  type Entry,
  type StatsDoc
} from "./msgstats.js"
import { peerOfEvent, peerOfTarget, startCollector, tallyOfKinds, tallyOfSegments } from "./msgcollect.js"
import type { MessageEvent, MessageSentInfo, Segment } from "@yunzai-ng/types"

/**
 * 造一条入账
 * @param over 要覆盖的字段
 * @returns 入账内容
 */
function entryOf(over: Partial<Entry> = {}): Entry {
  return {
    at: Date.now(),
    peer: "group:1",
    name: "测试群",
    scene: "group",
    dir: "recv",
    tally: { messages: 1, images: 0, stickers: 0 },
    ...over
  }
}

describe("dayKey", () => {
  it("按本地时区切天，而非 UTC", () => {
    // 东八区凌晨 1 点：UTC 仍是前一天。按 UTC 切会把这条记到昨天，
    // 表现为「今天明明聊过，统计里是 0」
    const at = new Date(2026, 8, 11, 1, 30).getTime()
    expect(dayKey(at)).toBe("2026-09-11")
    expect(new Date(at).toISOString().slice(0, 10)).not.toBe(dayKey(at))
  })

  it("月日补零", () => {
    expect(dayKey(new Date(2026, 0, 5, 12).getTime())).toBe("2026-01-05")
  })
})

describe("shiftDay", () => {
  it("跨月", () => {
    expect(shiftDay("2026-01-31", 1)).toBe("2026-02-01")
  })

  it("跨年往回", () => {
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31")
  })

  it("闰年二月", () => {
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29")
  })
})

describe("StatsBuckets", () => {
  it("同一天同一会话累加，收发各归各", () => {
    const at = new Date(2026, 8, 11, 10).getTime()
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at, dir: "recv", tally: { messages: 1, images: 2, stickers: 1 } }))
    buckets.add(entryOf({ at, dir: "recv", tally: { messages: 1, images: 0, stickers: 0 } }))
    buckets.add(entryOf({ at, dir: "sent", tally: { messages: 1, images: 1, stickers: 0 } }))

    const peer = buckets.snapshot().days["2026-09-11"]?.peers["group:1"]
    expect(peer?.recv).toEqual({ messages: 2, images: 2, stickers: 1 })
    expect(peer?.sent).toEqual({ messages: 1, images: 1, stickers: 0 })
  })

  it("跨天落进不同的桶", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: new Date(2026, 8, 11, 23, 59).getTime() }))
    buckets.add(entryOf({ at: new Date(2026, 8, 12, 0, 1).getTime() }))
    expect(Object.keys(buckets.snapshot().days)).toEqual(["2026-09-11", "2026-09-12"])
  })

  it("dirty 在入账后为真、取快照后转假", () => {
    const buckets = new StatsBuckets()
    expect(buckets.dirty).toBe(false)
    buckets.add(entryOf())
    expect(buckets.dirty).toBe(true)
    buckets.snapshot()
    expect(buckets.dirty).toBe(false)
  })

  it("名字更新，但兜底名不覆盖真名", () => {
    const at = Date.now()
    const buckets = new StatsBuckets()
    // 先收到（带群名），再发出（发送侧只有兜底名 `群 1`）
    buckets.add(entryOf({ at, name: "老群名", dir: "recv" }))
    buckets.add(entryOf({ at, name: "新群名", dir: "recv" }))
    expect(buckets.snapshot().days[dayKey(at)]?.peers["group:1"]?.name).toBe("新群名")
  })

  it("名字等于标识时不覆盖已有的名字", () => {
    const at = Date.now()
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at, name: "真群名" }))
    buckets.add(entryOf({ at, name: "group:1" }))
    expect(buckets.snapshot().days[dayKey(at)]?.peers["group:1"]?.name).toBe("真群名")
  })

  it("prune 保留今天往前数 KEEP_DAYS 天，更早的丢掉", () => {
    const now = new Date(2026, 8, 11, 12).getTime()
    const today = dayKey(now)
    const buckets = new StatsBuckets()
    // 边界内的最后一天与边界外的第一天
    const keep = shiftDay(today, -(KEEP_DAYS - 1))
    const drop = shiftDay(today, -KEEP_DAYS)
    buckets.add(entryOf({ at: new Date(`${keep}T12:00:00`).getTime() }))
    buckets.add(entryOf({ at: new Date(`${drop}T12:00:00`).getTime() }))
    buckets.add(entryOf({ at: now }))

    expect(buckets.prune(now)).toBe(1)
    const days = Object.keys(buckets.snapshot().days)
    expect(days).toContain(keep)
    expect(days).toContain(today)
    expect(days).not.toContain(drop)
  })

  it("没删掉任何天时不置 dirty", () => {
    const now = Date.now()
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: now }))
    buckets.snapshot()
    expect(buckets.prune(now)).toBe(0)
    expect(buckets.dirty).toBe(false)
  })

  it("快照按日期升序，便于直接画图", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: new Date(2026, 8, 13, 10).getTime() }))
    buckets.add(entryOf({ at: new Date(2026, 8, 11, 10).getTime() }))
    buckets.add(entryOf({ at: new Date(2026, 8, 12, 10).getTime() }))
    expect(Object.keys(buckets.snapshot().days)).toEqual(["2026-09-11", "2026-09-12", "2026-09-13"])
  })

  it("从文档恢复", () => {
    const doc: StatsDoc = {
      version: 2,
      days: {
        "2026-09-10": {
          day: "2026-09-10",
          peers: {
            "group:9": {
              peer: "group:9",
              name: "旧群",
              scene: "group",
              recv: { messages: 5, images: 1, stickers: 2 },
              sent: emptyTally()
            }
          }
        }
      }
    }
    const buckets = new StatsBuckets(doc)
    expect(buckets.snapshot().days["2026-09-10"]?.peers["group:9"]?.recv.messages).toBe(5)
  })
})

describe("parseStatsDoc", () => {
  it("认下形状正确的文档", () => {
    const doc = parseStatsDoc({
      version: 2,
      days: {
        "2026-09-11": {
          day: "2026-09-11",
          peers: {
            "private:7": { name: "某人", scene: "private", recv: { messages: 3, images: 0, stickers: 0 }, sent: {} }
          }
        }
      }
    })
    expect(doc?.days["2026-09-11"]?.peers["private:7"]?.recv.messages).toBe(3)
    // 缺失的 sent 归零而非丢掉整条
    expect(doc?.days["2026-09-11"]?.peers["private:7"]?.sent).toEqual(emptyTally())
  })

  it("版本不认识时整份丢弃，而不是照旧字段解读", () => {
    expect(parseStatsDoc({ version: 3, days: {} })).toBeUndefined()
  })

  /*
   * 版本 1 一并作废，尽管它的 days 结构与 2 兼容
   *
   * 1 没有账号维度，迁移过来只能把全部历史记到一个「未知账号」名下 —— 那会让「按账号
   * 筛选」的结果长期是错的，且错得看不出来（数字都在，只是永远归给同一个号）。
   * 从空开始更诚实，代价是升级时丢掉已采的那几天。
   */
  it("版本 1 也作废 —— 它没有账号维度，迁移过来只会让筛选长期出错", () => {
    const v1 = {
      version: 1,
      days: {
        "2026-09-11": {
          peers: { "group:1": { scene: "group", recv: { messages: 9 }, sent: {} } }
        }
      }
    }
    expect(parseStatsDoc(v1)).toBeUndefined()
  })

  it("非对象、null 一律不认", () => {
    expect(parseStatsDoc(null)).toBeUndefined()
    expect(parseStatsDoc("{}")).toBeUndefined()
    expect(parseStatsDoc([])).toBeUndefined()
  })

  it("日期键格式不对的天跳过", () => {
    const doc = parseStatsDoc({ version: 2, days: { 昨天: { peers: {} }, "2026-09-11": { peers: {} } } })
    expect(Object.keys(doc?.days ?? {})).toEqual(["2026-09-11"])
  })

  it("scene 不合法的会话丢掉 —— 它决定按群还是按私聊归类", () => {
    const doc = parseStatsDoc({
      version: 2,
      days: { "2026-09-11": { peers: { "x:1": { scene: "channel", recv: {}, sent: {} } } } }
    })
    expect(doc?.days["2026-09-11"]?.peers).toEqual({})
  })

  it("被改坏的数字归零，那个会话仍在", () => {
    const doc = parseStatsDoc({
      version: 2,
      days: {
        "2026-09-11": {
          peers: {
            "group:1": {
              scene: "group",
              recv: { messages: -5, images: "多", stickers: Number.NaN },
              sent: { messages: 2.7 }
            }
          }
        }
      }
    })
    const peer = doc?.days["2026-09-11"]?.peers["group:1"]
    expect(peer?.recv).toEqual(emptyTally())
    expect(peer?.sent.messages).toBe(2)
  })
})

describe("aggregate", () => {
  /**
   * 造一份两天两会话的文档
   * @returns 文档
   */
  function docOf(): StatsDoc {
    return {
      version: 2,
      days: {
        "2026-09-10": {
          day: "2026-09-10",
          peers: {
            "group:1": {
              peer: "group:1",
              name: "甲群",
              scene: "group",
              recv: { messages: 10, images: 2, stickers: 1 },
              sent: { messages: 4, images: 1, stickers: 0 }
            }
          }
        },
        "2026-09-12": {
          day: "2026-09-12",
          peers: {
            "group:1": {
              peer: "group:1",
              name: "甲群改名了",
              scene: "group",
              recv: { messages: 1, images: 0, stickers: 0 },
              sent: emptyTally()
            },
            "private:7": {
              peer: "private:7",
              name: "某人",
              scene: "private",
              recv: { messages: 30, images: 0, stickers: 5 },
              sent: { messages: 30, images: 0, stickers: 0 }
            }
          }
        }
      }
    }
  }

  it("区间内没数据的天补 0 且仍在 series 里", () => {
    const agg = aggregate(docOf(), "2026-09-10", "2026-09-12")
    expect(agg.series.map(item => item.label)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"])
    expect(agg.unit).toBe("day")
    expect(agg.series[1]?.recv).toEqual(emptyTally())
  })

  it("总计是区间内各天之和", () => {
    const agg = aggregate(docOf(), "2026-09-10", "2026-09-12")
    expect(agg.total.recv).toEqual({ messages: 41, images: 2, stickers: 6 })
    expect(agg.total.sent).toEqual({ messages: 34, images: 1, stickers: 0 })
  })

  it("区间外的天不计入", () => {
    const agg = aggregate(docOf(), "2026-09-12", "2026-09-12")
    expect(agg.total.recv.messages).toBe(31)
    expect(agg.peers.map(item => item.peer)).toEqual(["private:7", "group:1"])
  })

  it("会话按收发总条数降序", () => {
    const agg = aggregate(docOf(), "2026-09-10", "2026-09-12")
    expect(agg.peers.map(item => item.peer)).toEqual(["private:7", "group:1"])
  })

  it("会话名取区间内最后出现的那个 —— 群改名后该显示新名字", () => {
    const agg = aggregate(docOf(), "2026-09-10", "2026-09-12")
    expect(agg.peers.find(item => item.peer === "group:1")?.name).toBe("甲群改名了")
  })

  it("区间写反时自动摆正，而不是给出空结果", () => {
    const agg = aggregate(docOf(), "2026-09-12", "2026-09-10")
    expect(agg.from).toBe("2026-09-10")
    expect(agg.to).toBe("2026-09-12")
    expect(agg.series).toHaveLength(3)
  })

  it("跨度极大时截断，不至于把内存转光", () => {
    const agg = aggregate({ version: 2, days: {} }, "2000-01-01", "2026-09-11")
    expect(agg.series.length).toBeLessThanOrEqual(401)
  })

  it("空文档给出的是一段 0，而非没有 series", () => {
    const agg = aggregate({ version: 2, days: {} }, "2026-09-11", "2026-09-11")
    expect(agg.series).toHaveLength(1)
    expect(agg.total.recv).toEqual(emptyTally())
    expect(agg.peers).toEqual([])
  })

  it("粒度标成 day，界面据它写副标题", () => {
    const agg = aggregate(docOf(), "2026-09-10", "2026-09-12")
    expect(agg.unit).toBe("day")
  })
})

describe("小时桶与账号维度", () => {
  /** 东八区 2026-09-11 的几个时刻 */
  const at9 = new Date(2026, 8, 11, 9, 30).getTime()
  const at14 = new Date(2026, 8, 11, 14, 5).getTime()

  it("同一条数据写进三处：会话总量、会话的账号细分、当天的小时槽", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "onebot11", account: "10001" } }))
    const day = buckets.snapshot().days["2026-09-11"]

    expect(day?.peers["group:1"]?.recv.messages).toBe(1)
    expect(day?.peers["group:1"]?.by?.["qq:10001"]?.recv.messages).toBe(1)
    expect(day?.hours?.["09"]?.recv.messages).toBe(1)
    expect(day?.hours?.["09"]?.by?.["qq:10001"]?.recv.messages).toBe(1)
  })

  it("小时槽按时刻归集，不同小时各自成格", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9 }))
    buckets.add(entryOf({ at: at14 }))
    buckets.add(entryOf({ at: at14 }))
    const hours = buckets.snapshot().days["2026-09-11"]?.hours
    expect(hours?.["09"]?.recv.messages).toBe(1)
    expect(hours?.["14"]?.recv.messages).toBe(2)
  })

  it("不带账号时不建 by —— 多数部署只有一个号，恒建一层会让文档凭空大一圈", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9 }))
    const day = buckets.snapshot().days["2026-09-11"]
    expect(day?.peers["group:1"]?.by).toBeUndefined()
    expect(day?.hours?.["09"]?.by).toBeUndefined()
  })

  it("账号身份记进 accounts 表，供界面显示成人能读的东西", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "onebot11", account: "10001" } }))
    expect(buckets.snapshot().accounts?.["qq:10001"]).toEqual({
      platform: "qq",
      adapter: "onebot11",
      account: "10001"
    })
  })

  it("身份后到的那份覆盖先前的 —— 收侧事件给不出 adapter，发侧给得出", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "", account: "10001" } }))
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "onebot11", account: "10001" } }))
    expect(buckets.snapshot().accounts?.["qq:10001"]?.adapter).toBe("onebot11")
  })

  it("记录 id 形态的旧键并回平台 id，两侧计数相加 —— 同一个号曾经裂成两个账号", () => {
    const buckets = new StatsBuckets()
    // 收侧用平台 id（QQ 号），发侧一度用记录 uuid：界面上于是出现两个账号
    buckets.add(entryOf({ at: at9, dir: "recv", account: { platform: "qq", adapter: "", account: "10001" } }))
    buckets.add(entryOf({ at: at9, dir: "sent", account: { platform: "qq", adapter: "onebot11", account: "uuid-1" } }))

    expect(buckets.remapAccounts(id => (id === "uuid-1" ? "10001" : undefined))).toBe(1)

    const doc = buckets.snapshot()
    // 只剩一个账号，且 adapter 由 uuid 那侧补上（收侧给不出）
    expect(Object.keys(doc.accounts ?? {})).toEqual(["qq:10001"])
    expect(doc.accounts?.["qq:10001"]?.adapter).toBe("onebot11")

    // 两侧的数都在，且落在同一个键下
    const by = doc.days["2026-09-11"]?.peers["group:1"]?.by
    expect(Object.keys(by ?? {})).toEqual(["qq:10001"])
    expect(by?.["qq:10001"]).toEqual({
      recv: { messages: 1, images: 0, stickers: 0 },
      sent: { messages: 1, images: 0, stickers: 0 }
    })
    // 小时槽那一份同样要改，漏掉的话「按小时筛这个账号」会少一截而不报错
    expect(Object.keys(doc.days["2026-09-11"]?.hours?.["09"]?.by ?? {})).toEqual(["qq:10001"])
  })

  it("换不到平台 id 时一个键都不动 —— 账号已被删掉时没有更好的猜法", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "onebot11", account: "uuid-1" } }))
    expect(buckets.remapAccounts(() => undefined)).toBe(0)
    expect(Object.keys(buckets.snapshot().accounts ?? {})).toEqual(["qq:uuid-1"])
  })

  it("按账号筛选时只算那一个号的数，而会话仍是同一行", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "", account: "10001" } }))
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "", account: "10002" } }))
    const doc = buckets.snapshot()

    expect(aggregate(doc, "2026-09-11", "2026-09-11").total.recv.messages).toBe(2)
    expect(aggregate(doc, "2026-09-11", "2026-09-11", "qq:10001").total.recv.messages).toBe(1)
    // 关键：两个号在同一个群里时，那个群仍是一行，而不是裂成两行
    expect(aggregate(doc, "2026-09-11", "2026-09-11").peers).toHaveLength(1)
  })

  it("筛一个从未出现过的账号得到 0，而不是退回全部账号之和", () => {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: at9, account: { platform: "qq", adapter: "", account: "10001" } }))
    const agg = aggregate(buckets.snapshot(), "2026-09-11", "2026-09-11", "qq:99999")
    expect(agg.total.recv).toEqual(emptyTally())
    expect(agg.peers).toEqual([])
  })

  it("裁剪只摘掉超过小时保留期那些天的 hours，天汇总留着", () => {
    const buckets = new StatsBuckets()
    const old = new Date(2026, 8, 1, 9).getTime()
    buckets.add(entryOf({ at: old }))
    // 以 9-11 为今天，9-1 已超出 7 天的小时保留期，但仍在 40 天的保留期内
    buckets.prune(new Date(2026, 8, 11, 12).getTime())

    const day = buckets.snapshot().days["2026-09-01"]
    expect(day?.peers["group:1"]?.recv.messages).toBe(1)
    expect(day?.hours).toBeUndefined()
  })
})

describe("aggregateHours", () => {
  const now = new Date(2026, 8, 11, 14, 30).getTime()

  /**
   * 造一份带小时桶的文档
   * @returns 文档
   */
  function hourDoc(): StatsDoc {
    const buckets = new StatsBuckets()
    buckets.add(entryOf({ at: new Date(2026, 8, 11, 9, 10).getTime() }))
    buckets.add(entryOf({ at: new Date(2026, 8, 11, 14, 20).getTime(), dir: "sent" }))
    return buckets.snapshot()
  }

  it("往前数 N 格，末格是此刻所在的那一小时", () => {
    const agg = aggregateHours(hourDoc(), now, 6)
    expect(agg.series).toHaveLength(6)
    expect(agg.series[agg.series.length - 1]?.label).toBe("14")
    expect(agg.unit).toBe("hour")
  })

  it("当日之内标签只有小时，跨天时带上日期 —— 否则两个「03」分不出是哪天", () => {
    const within = aggregateHours(hourDoc(), now, 6)
    expect(within.series.map(item => item.label)).toEqual(["09", "10", "11", "12", "13", "14"])

    const across = aggregateHours(hourDoc(), now, 20)
    expect(across.series[0]?.label).toMatch(/^09-10 \d{2}$/)
  })

  it("把落在窗口内的小时算进总计，窗口外的不算", () => {
    // 9 点那条在 6 格窗口（09..14）之内
    expect(aggregateHours(hourDoc(), now, 6).total.recv.messages).toBe(1)
    // 3 格窗口是 12..14，9 点那条落在窗外
    expect(aggregateHours(hourDoc(), now, 3).total.recv.messages).toBe(0)
    expect(aggregateHours(hourDoc(), now, 3).total.sent.messages).toBe(1)
  })

  it("没数据的小时补 0 且仍在 series 里 —— 缺格会让人以为那一小时不存在", () => {
    const agg = aggregateHours(hourDoc(), now, 6)
    expect(agg.series[1]?.recv).toEqual(emptyTally())
  })

  it("窗口长度被夹在小时桶的保留期内，防止要一个必然全 0 的跨度", () => {
    const agg = aggregateHours(hourDoc(), now, 99_999)
    expect(agg.series.length).toBeLessThanOrEqual(24 * HOUR_KEEP_DAYS)
  })

  it("按账号筛选同样生效", () => {
    const buckets = new StatsBuckets()
    const at = new Date(2026, 8, 11, 13, 0).getTime()
    buckets.add(entryOf({ at, account: { platform: "qq", adapter: "", account: "10001" } }))
    buckets.add(entryOf({ at, account: { platform: "qq", adapter: "", account: "10002" } }))
    const doc = buckets.snapshot()

    expect(aggregateHours(doc, now, 3).total.recv.messages).toBe(2)
    expect(aggregateHours(doc, now, 3, "qq:10001").total.recv.messages).toBe(1)
  })
})

describe("tallyOfSegments", () => {
  it("一条消息算一条，图片按段数计", () => {
    const segments: Segment[] = [
      { type: "text", text: "看图" },
      { type: "image", file: { kind: "url", url: "https://x/a.png" } },
      { type: "image", file: { kind: "url", url: "https://x/b.png" } }
    ]
    expect(tallyOfSegments(segments)).toEqual({ messages: 1, images: 2, stickers: 0 })
  })

  it("subType 为 1 的图既算图片也算表情包", () => {
    const segments: Segment[] = [{ type: "image", file: { kind: "url", url: "https://x/s.png" }, subType: 1 }]
    expect(tallyOfSegments(segments)).toEqual({ messages: 1, images: 1, stickers: 1 })
  })

  it("face 段算表情包但不算图片", () => {
    const segments: Segment[] = [{ type: "face", id: 4 }]
    expect(tallyOfSegments(segments)).toEqual({ messages: 1, images: 0, stickers: 1 })
  })

  it("纯文本只有条数", () => {
    const segments: Segment[] = [{ type: "text", text: "喂" }]
    expect(tallyOfSegments(segments)).toEqual({
      messages: 1,
      images: 0,
      stickers: 0
    })
  })

  it("空消息段仍算一条 —— 收到了就是收到了", () => {
    expect(tallyOfSegments([])).toEqual({ messages: 1, images: 0, stickers: 0 })
  })
})

describe("tallyOfKinds", () => {
  it("按 kinds 里的段类型计数", () => {
    expect(tallyOfKinds({ text: 1, image: 3, face: 2 })).toEqual({ messages: 1, images: 3, stickers: 2 })
  })

  it("发送侧数不出表情图 —— kinds 没有 subType，这是已知限制", () => {
    // 内核把 `[{image, subType:1}]` 聚合成 `{image: 1}`，表情图与普通图在此不可分
    expect(tallyOfKinds({ image: 1 }).stickers).toBe(0)
  })

  it("适配器给的怪数字一律归零", () => {
    expect(tallyOfKinds({ image: -1, face: Number.NaN })).toEqual({ messages: 1, images: 0, stickers: 0 })
    expect(tallyOfKinds({ image: 2.9 }).images).toBe(2)
  })

  it("空 kinds 仍算一条", () => {
    expect(tallyOfKinds({})).toEqual({ messages: 1, images: 0, stickers: 0 })
  })
})

describe("peerOfEvent 与 peerOfTarget", () => {
  it("同一个群的收与发拼出同一个标识 —— 不然界面上每个群只有一半数据", () => {
    const e = {
      scene: "group",
      group: { gid: "123", name: "甲群" },
      sender: { uid: "7" }
    } as unknown as MessageEvent
    const target = { scene: "group", gid: "123" } as MessageSentInfo["target"]
    expect(peerOfEvent(e).peer).toBe(peerOfTarget(target).peer)
  })

  it("同一个人的私聊收与发拼出同一个标识", () => {
    const e = { scene: "private", sender: { uid: "7", name: "某人" } } as unknown as MessageEvent
    const target = { scene: "private", uid: "7" } as MessageSentInfo["target"]
    expect(peerOfEvent(e).peer).toBe(peerOfTarget(target).peer)
  })

  it("同一个子频道的收与发拼出同一个标识", () => {
    const e = {
      scene: "guild",
      channel: { guildId: "g1", channelId: "c2", name: "闲聊" },
      sender: { uid: "7" }
    } as unknown as MessageEvent
    const target = { scene: "guild", guildId: "g1", channelId: "c2" } as MessageSentInfo["target"]
    expect(peerOfEvent(e).peer).toBe(peerOfTarget(target).peer)
  })

  it("群消息按群归集，不按发言人", () => {
    const e = {
      scene: "group",
      group: { gid: "123", name: "甲群" },
      sender: { uid: "7", name: "某人" }
    } as unknown as MessageEvent
    expect(peerOfEvent(e)).toEqual({ peer: "group:123", name: "甲群", scene: "group" })
  })

  it("群名缺失时给兜底名，且该名字不会盖掉已有的真名", () => {
    const e = { scene: "group", group: { gid: "123" }, sender: { uid: "7" } } as unknown as MessageEvent
    expect(peerOfEvent(e).name).toBe("群 123")
  })

  it("场景说是群但没有群信息时退回私聊，不至于丢掉这一条", () => {
    const e = { scene: "group", sender: { uid: "7", name: "某人" } } as unknown as MessageEvent
    expect(peerOfEvent(e)).toEqual({ peer: "private:7", name: "某人", scene: "private" })
  })

  it("私聊临时会话按对方 uid 归集，不按来源群", () => {
    const target = { scene: "private", uid: "7", gid: "123" } as MessageSentInfo["target"]
    expect(peerOfTarget(target).peer).toBe("private:7")
  })
})

describe("采集侧的账号键", () => {
  /**
   * 起一个采集器，把它订阅的处理函数交回来
   * @param dir 数据目录
   * @param selfIdOf 记录 id 到平台 id 的换算
   * @returns 采集器与各事件的处理函数
   */
  async function harness(
    dir: string,
    selfIdOf?: (id: string) => string | undefined
  ): Promise<{
    collector: Awaited<ReturnType<typeof startCollector>>
    handlers: Map<string, (arg: never) => unknown>
  }> {
    const handlers = new Map<string, (arg: never) => unknown>()
    const collector = await startCollector({
      dataDir: dir,
      logger: { warn: () => undefined, debug: () => undefined },
      on: (event, handler) => {
        handlers.set(event, handler as (arg: never) => unknown)
        return () => undefined
      },
      ...(selfIdOf === undefined ? {} : { selfIdOf })
    })
    return { collector, handlers }
  }

  /** 造一条发出事件 */
  const sentInfo = (accountId: string): MessageSentInfo =>
    ({
      ok: true,
      platform: "qq",
      accountId,
      adapterId: "onebot11",
      target: { scene: "group", gid: "123" },
      kinds: { text: 1 }
    }) as unknown as MessageSentInfo

  it("发侧的记录 id 换成平台 id，与收侧落在同一个账号下", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yzng-collect-"))
    try {
      const { collector, handlers } = await harness(dir, id => (id === "uuid-1" ? "10001" : undefined))
      // 收侧给的是平台 id
      handlers.get("message")?.({
        time: Date.now(),
        platform: "qq",
        selfId: "10001",
        scene: "group",
        group: { gid: "123", name: "甲群" },
        sender: { uid: "7" },
        message: [{ type: "text", text: "喂" }]
      } as never)
      // 发侧给的是记录 uuid —— 不换算的话这里会多出一个 `qq:uuid-1`
      handlers.get("message/sent")?.(sentInfo("uuid-1") as never)

      const doc = collector.read()
      expect(Object.keys(doc.accounts ?? {})).toEqual(["qq:10001"])
      const by = Object.values(doc.days)[0]?.peers["group:123"]?.by
      expect(Object.keys(by ?? {})).toEqual(["qq:10001"])
      expect(by?.["qq:10001"]).toEqual({
        recv: { messages: 1, images: 0, stickers: 0 },
        sent: { messages: 1, images: 0, stickers: 0 }
      })
      await collector.stop()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("换不到时退回记录 id，不丢这一条", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yzng-collect-"))
    try {
      const { collector, handlers } = await harness(dir, () => undefined)
      handlers.get("message/sent")?.(sentInfo("uuid-9") as never)

      const doc = collector.read()
      expect(Object.keys(doc.accounts ?? {})).toEqual(["qq:uuid-9"])
      await collector.stop()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
