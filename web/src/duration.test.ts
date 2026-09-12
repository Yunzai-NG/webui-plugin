/**
 * 模块职责：`duration.ts` 的用例 —— 拆解、复原，以及「读不懂」这一态
 * 依赖方向：测试文件，只依赖被测模块
 * 生命周期：纯函数，无夹具
 * 注意事项：断言集中在**两条会静默出错的边界**上 —— 读不懂的写法必须给 undefined 而不是
 *          按 0 呈现（否则使用者一保存就抹掉了自己没碰过的字段），以及毫秒必须复原成
 *          数值而不是 `"0ms"`（否则看起来像框架在乱改配置文件）。
 */
import { describe, expect, it } from "vitest"
import { joinDuration, splitDuration } from "./duration.js"

describe("拆解时长", () => {
  it("数字按毫秒收 —— YAML 里读出来的 5000 正是这种", () => {
    expect(splitDuration(5000)).toEqual({ n: 5000, unit: "ms" })
    expect(splitDuration("5000")).toEqual({ n: 5000, unit: "ms" })
  })

  it("认得五种单位，小数与负数照收", () => {
    expect(splitDuration("30s")).toEqual({ n: 30, unit: "s" })
    expect(splitDuration("1m")).toEqual({ n: 1, unit: "m" })
    expect(splitDuration("2h")).toEqual({ n: 2, unit: "h" })
    expect(splitDuration("1d")).toEqual({ n: 1, unit: "d" })
    expect(splitDuration("1.5m")).toEqual({ n: 1.5, unit: "m" })
    // 负数在这里读得出来，该不该收由调用方判 —— 内核就是在它那侧另挡了一道
    expect(splitDuration("-2s")).toEqual({ n: -2, unit: "s" })
    expect(splitDuration("  30s  ")).toEqual({ n: 30, unit: "s" })
  })

  /*
   * 读不懂就说读不懂，别按 0 呈现
   *
   * `"1h30m"` 是内核也不接受、却确实会被人手写进 yaml 的写法。拆成 `{ n: 0 }` 的后果是
   * 界面显示 0，而使用者只要保存一次就把原值换成了 0 —— 他并没有碰那个字段。
   */
  it("读不懂的写法给 undefined，由调用方退回纯文本框", () => {
    for (const value of ["1h30m", "一会儿", "s", "", "  ", "30 s", "30sec"]) {
      expect(splitDuration(value)).toBeUndefined()
    }
    expect(splitDuration(Number.NaN)).toBeUndefined()
    expect(splitDuration(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(splitDuration(undefined)).toBeUndefined()
    expect(splitDuration(null)).toBeUndefined()
    expect(splitDuration({ n: 1 })).toBeUndefined()
    expect(splitDuration(true)).toBeUndefined()
  })
})

describe("复原时长", () => {
  it("毫秒复原成数值而非 \"0ms\"", () => {
    expect(joinDuration("0", "ms")).toBe(0)
    expect(joinDuration("5000", "ms")).toBe(5000)
  })

  it("其余单位拼成表达式", () => {
    expect(joinDuration("30", "s")).toBe("30s")
    expect(joinDuration("1.5", "m")).toBe("1.5m")
    expect(joinDuration(" 2 ", "h")).toBe("2h")
  })

  it("填不出东西时给 undefined，由调用方决定那意味着什么", () => {
    // 配置表单读作「这次不提交」，账号的重连覆盖读作「这一项跟随全局」—— 处置相反，故不在这里替谁决定
    expect(joinDuration("", "s")).toBeUndefined()
    expect(joinDuration("   ", "s")).toBeUndefined()
    expect(joinDuration("abc", "s")).toBeUndefined()
    expect(joinDuration("30", "周")).toBeUndefined()
  })

  it("拆完再拼回去还是同一个值", () => {
    for (const value of [0, 5000, "30s", "1.5m", "2h", "1d"] as const) {
      const parts = splitDuration(value)
      expect(parts).toBeDefined()
      expect(joinDuration(String(parts?.n), parts?.unit ?? "")).toBe(value)
    }
  })
})
