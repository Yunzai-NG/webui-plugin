import { describe, expect, it } from "vitest"
import { RING_CIRCUMFERENCE, gaugeLevel, percent, ratioOf, ringDash } from "./gauge.js"

describe("比例", () => {
  it("常规取值", () => {
    expect(ratioOf(600, 1000)).toBeCloseTo(0.6)
  })

  it("**总量为 0 时没有比例可言，给 undefined 而不是 0** —— 空光驱不是「0% 已用」", () => {
    expect(ratioOf(0, 0)).toBeUndefined()
    expect(ratioOf(5, -1)).toBeUndefined()
    expect(ratioOf(5, Number.NaN)).toBeUndefined()
  })

  it("越界的已用量夹回 0-1", () => {
    expect(ratioOf(1200, 1000)).toBe(1)
    expect(ratioOf(-5, 1000)).toBe(0)
  })
})

describe("着色档位", () => {
  it("低于 70% 取中性", () => {
    expect(gaugeLevel(0)).toBe("")
    expect(gaugeLevel(0.699)).toBe("")
  })

  it("70% 至 90% 取 warn", () => {
    expect(gaugeLevel(0.7)).toBe("warn")
    expect(gaugeLevel(0.899)).toBe("warn")
  })

  it("90% 以上取 err", () => {
    expect(gaugeLevel(0.9)).toBe("err")
    expect(gaugeLevel(1)).toBe("err")
  })

  it("**测不到时取中性，不取 err** —— 测不到不是一种告警", () => {
    expect(gaugeLevel(undefined)).toBe("")
  })
})

describe("环的几何", () => {
  /**
   * 取 dasharray 的两段
   * @param ratio 比例
   * @returns 两段长度
   */
  function parts(ratio: number | undefined): [number, number] {
    const [a, b] = ringDash(ratio).split(" ").map(Number)
    return [a ?? 0, b ?? 0]
  }

  it("两段之和恒为周长 —— 否则环上会出现画不满或叠一圈", () => {
    for (const ratio of [0, 0.25, 0.5, 0.777, 1, undefined]) {
      const [a, b] = parts(ratio)
      expect(a + b).toBeCloseTo(RING_CIRCUMFERENCE, 1)
    }
  })

  it("半满时弧长为半个周长", () => {
    expect(parts(0.5)[0]).toBeCloseTo(RING_CIRCUMFERENCE / 2, 1)
  })

  it("测不到时按空环画 —— 组件此时本不该画它，但也不能画成整圈", () => {
    expect(parts(undefined)[0]).toBe(0)
  })
})

describe("百分数文案", () => {
  it("取整，不留小数 —— 小数位会让数字每次刷新都在跳", () => {
    expect(percent(0.314)).toBe("31%")
    expect(percent(0.316)).toBe("32%")
  })

  it("**测不到时给破折号，不给 0%** —— 0% 会被读成「空闲」", () => {
    expect(percent(undefined)).toBe("—")
  })
})
