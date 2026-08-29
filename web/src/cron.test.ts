/**
 * 模块职责：`cron.ts` 的用例 —— 分段拆合与下次触发时刻
 * 依赖方向：测试文件，只依赖被测模块
 * 生命周期：纯函数，无夹具
 * 注意事项：一律传入固定的起算时刻，不取 `Date.now()` —— 取当前时间的用例会在某些
 *          时刻莫名失败（比如恰好跨过整分），而那种失败查起来极耗时间。
 *
 *          时刻断言以本地时区构造期望值（`new Date(y, m, d, ...)`），与被测模块一致。
 *          写成 UTC 字面量的话，这些用例在非 UTC+8 的机器上会全部失败。
 */
import { describe, expect, it } from "vitest"
import { CRON_FIELDS, explodeCron, joinCron, previewCron, splitCron } from "./cron.js"

/**
 * 本地时刻 → 毫秒时间戳
 * @param y 年
 * @param mo 月，1 起
 * @param d 日
 * @param h 时
 * @param mi 分
 * @param s 秒
 * @returns 毫秒时间戳
 */
function at(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

describe("分段拆合", () => {
  it("六段原样、五段补空秒段", () => {
    expect(explodeCron("0 30 8 * * 1")).toEqual(["0", "30", "8", "*", "*", "1"])
    expect(explodeCron("30 8 * * 1")).toEqual(["", "30", "8", "*", "*", "1"])
  })

  it("秒段留空得五段，填了得六段", () => {
    expect(joinCron(["", "30", "8", "*", "*", "*"])).toBe("30 8 * * *")
    expect(joinCron(["0", "30", "8", "*", "*", "*"])).toBe("0 30 8 * * *")
  })

  it("其余各段留空按 * 计", () => {
    expect(joinCron(["", "", "8", "", "", ""])).toBe("* 8 * * *")
  })

  it("全部留空得空串，不凭空造出「每分钟」", () => {
    expect(joinCron(["", "", "", "", "", ""])).toBe("")
    expect(joinCron([])).toBe("")
  })

  it("拆与合互为逆操作", () => {
    for (const expr of ["30 8 * * *", "0 0 8 * * *", "*/5 * * * *", "0 0 1 * 1"]) {
      expect(joinCron(explodeCron(expr))).toBe(expr)
    }
  })

  it("段数异常时原样铺开，不清空使用者写下的内容", () => {
    expect(explodeCron("0 8")).toEqual(["0", "8", "", "", "", ""])
    expect(splitCron("  ")).toEqual([])
  })

  it("六段的定义顺序即秒分时日月周", () => {
    expect(CRON_FIELDS.map(f => f.label)).toEqual(["秒", "分", "时", "日", "月", "周"])
    expect(CRON_FIELDS[0]?.optional).toBe(true)
  })
})

describe("下次触发时刻", () => {
  it("每天固定时刻：跨到次日", () => {
    const out = previewCron("0 8 * * *", at(2026, 8, 25, 10, 0, 0), 2)
    expect(out.ok).toBe(true)
    expect(out.times).toEqual([at(2026, 8, 26, 8, 0), at(2026, 8, 27, 8, 0)])
  })

  it("当天尚未到点时先给当天", () => {
    const out = previewCron("0 8 * * *", at(2026, 8, 25, 7, 59, 59), 1)
    expect(out.times).toEqual([at(2026, 8, 25, 8, 0)])
  })

  it("结果一律晚于起算时刻，恰好等于时不算", () => {
    const out = previewCron("0 8 * * *", at(2026, 8, 25, 8, 0, 0), 1)
    expect(out.times).toEqual([at(2026, 8, 26, 8, 0)])
  })

  it("六段写法的秒段生效", () => {
    const out = previewCron("30 0 8 * * *", at(2026, 8, 25, 7, 0, 0), 1)
    expect(out.times).toEqual([at(2026, 8, 25, 8, 0, 30)])
  })

  it("步长与列表", () => {
    const out = previewCron("*/15 9 * * *", at(2026, 8, 25, 9, 0, 0), 3)
    expect(out.times).toEqual([at(2026, 8, 25, 9, 15), at(2026, 8, 25, 9, 30), at(2026, 8, 25, 9, 45)])
    const list = previewCron("0,20,40 9 * * *", at(2026, 8, 25, 9, 25, 0), 2)
    expect(list.times).toEqual([at(2026, 8, 25, 9, 40), at(2026, 8, 26, 9, 0)])
  })

  it("单值加步长意为「自该值起每 n 个」", () => {
    const out = previewCron("5/20 9 * * *", at(2026, 8, 25, 9, 0, 0), 3)
    expect(out.times).toEqual([at(2026, 8, 25, 9, 5), at(2026, 8, 25, 9, 25), at(2026, 8, 25, 9, 45)])
  })

  it("**「日」与「周」两段都受限时取并集** —— 这是与直觉相反的那条 vixie 规则", () => {
    // 2026-09：1 号为周二；最近的周一是 9 月 7 日
    const out = previewCron("0 0 1 9 1", at(2026, 8, 31, 12, 0, 0), 3)
    expect(out.times).toEqual([at(2026, 9, 1, 0, 0), at(2026, 9, 7, 0, 0), at(2026, 9, 14, 0, 0)])
  })

  it("其中一段为 * 时由另一段单独决定", () => {
    const weekly = previewCron("0 0 * * 1", at(2026, 8, 25, 12, 0, 0), 2)
    expect(weekly.times).toEqual([at(2026, 8, 31, 0, 0), at(2026, 9, 7, 0, 0)])
    const monthly = previewCron("0 0 1 * *", at(2026, 8, 25, 12, 0, 0), 2)
    expect(monthly.times).toEqual([at(2026, 9, 1, 0, 0), at(2026, 10, 1, 0, 0)])
  })

  it("周日既可写 0 也可写 7", () => {
    const zero = previewCron("0 0 * * 0", at(2026, 8, 25, 12, 0, 0), 1)
    const seven = previewCron("0 0 * * 7", at(2026, 8, 25, 12, 0, 0), 1)
    expect(zero.times).toEqual([at(2026, 8, 30, 0, 0)])
    expect(seven.times).toEqual(zero.times)
  })

  it("英文月名与星期名不分大小写", () => {
    const out = previewCron("0 0 * SEP mon", at(2026, 8, 25, 12, 0, 0), 1)
    expect(out.times).toEqual([at(2026, 9, 7, 0, 0)])
  })

  it("闰日：跨年也能找到", () => {
    const out = previewCron("0 0 29 2 *", at(2026, 8, 25, 12, 0, 0), 1)
    expect(out.times).toEqual([at(2028, 2, 29, 0, 0)])
  })

  it("永不触发的组合如实说明，而不是空着", () => {
    const out = previewCron("0 0 30 2 *", at(2026, 8, 25, 12, 0, 0), 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain("不会触发")
  })

  it("空表达式与段数不对都给出原因", () => {
    expect(previewCron("", 0).reason).toBe("尚未填写")
    expect(previewCron("0 8", 0).reason).toContain("2 段")
  })

  it("高级写法不推算，并说明内核仍会执行", () => {
    const out = previewCron("0 0 L * *", at(2026, 8, 25), 1)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain("高级写法")
    expect(out.reason).toContain("内核仍会")
  })

  it("拼错的星期名报「无法识别」而非「高级写法」", () => {
    const out = previewCron("0 0 * * WEDX", at(2026, 8, 25), 1)
    expect(out.reason).toContain("无法识别")
  })

  it("超出取值范围的段无法识别", () => {
    expect(previewCron("0 25 * * *", at(2026, 8, 25), 1).reason).toContain("无法识别")
    expect(previewCron("0 0 0 * *", at(2026, 8, 25), 1).reason).toContain("「日」")
  })

  it("每秒触发也能在合理时间内算出，不逐个构造候选时刻", () => {
    const out = previewCron("* * * * * *", at(2026, 8, 25, 23, 59, 57), 3)
    expect(out.times).toEqual([at(2026, 8, 25, 23, 59, 58), at(2026, 8, 25, 23, 59, 59), at(2026, 8, 26, 0, 0, 0)])
  })
})
