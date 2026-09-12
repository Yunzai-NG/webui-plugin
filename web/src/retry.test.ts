/**
 * 模块职责：`retry.ts` 的用例 —— 三态往返、`0` 与「没填」之分、以及摘要文案
 * 依赖方向：测试文件，只依赖被测模块与类型
 * 生命周期：纯函数，无夹具
 * 注意事项：这组用例守的是**一条会静默出错的分界：`0` 不是「没填」**。`limit: 0` 是
 *          「一直重连」、`interval: 0` 是「不等待、立刻重试」，两者都是合法取值 ——
 *          若表单把 0 与留空混作一谈，一次「我没填这项」会变成一条实际生效的策略，
 *          而界面上看不出区别。故凡涉及 0 的分支各有一条断言。
 *
 *          另一条是**四项全空必须给 `null` 而不是 `{}`**：内核那侧 `{}` 会被存成一个
 *          存在但为空的 `retry`，此后「这个号有没有自定义」的判断从此含糊。
 */
import { describe, expect, it } from "vitest"
import { globalNote, globalRetryOf, isRetryCustom, retryFormOf, retryOverrideOf, retrySummary } from "./retry.js"
import type { RetryForm } from "./retry.js"

/**
 * 造一份表单态
 * @param over 覆盖字段
 * @returns 表单态
 */
function form(over: Partial<RetryForm> = {}): RetryForm {
  return { ...retryFormOf(undefined), ...over }
}

describe("铺开已存的覆盖", () => {
  it("没有覆盖时四项全空，单位落在秒上", () => {
    expect(retryFormOf(undefined)).toEqual({
      limit: "",
      interval: "",
      intervalUnit: "s",
      maxInterval: "",
      maxIntervalUnit: "s",
      factor: ""
    })
  })

  // 0 与没填在输入框里都是可见的，但意思天差地别：0 是「一直重连」
  it("limit 为 0 时格子里是 \"0\" 而非空", () => {
    expect(retryFormOf({ limit: 0 }).limit).toBe("0")
    expect(retryFormOf({}).limit).toBe("")
  })

  it("时长拆成数值与单位", () => {
    const filled = retryFormOf({ interval: "30s", maxInterval: 90_000 })
    expect(filled.interval).toBe("30")
    expect(filled.intervalUnit).toBe("s")
    expect(filled.maxInterval).toBe("90000")
    expect(filled.maxIntervalUnit).toBe("ms")
  })

  /*
   * 读不懂的值落进格子里，不丢掉
   *
   * 内核在入口处已按 `isDurationLike` 判过，正常情形下走不到这里；能走到说明有人直接
   * 改了 kv 存储。抹掉它一定不对 —— 使用者会看到一个空格子，保存一次就把原值换掉了。
   */
  it("读不懂的时长原样落进数值格", () => {
    expect(retryFormOf({ interval: "1h30m" as never }).interval).toBe("1h30m")
  })
})

describe("收成请求体", () => {
  it("四项全空给 null —— 那是内核的「清掉覆盖、回到跟随全局」", () => {
    expect(retryOverrideOf(form())).toBeNull()
  })

  it("只填了的项才送上去，没填的不补默认值", () => {
    // 补上此刻的全局值等于把「跟随全局」偷换成「此刻的全局值」，而后者不再跟着全局改动走
    expect(retryOverrideOf(form({ limit: "5" }))).toEqual({ limit: 5 })
  })

  it("limit 填 0 要送出去，不能当成没填", () => {
    expect(retryOverrideOf(form({ limit: "0" }))).toEqual({ limit: 0 })
  })

  it("时长按单位拼回去，毫秒给数值", () => {
    expect(retryOverrideOf(form({ interval: "30", intervalUnit: "s" }))).toEqual({ interval: "30s" })
    expect(retryOverrideOf(form({ maxInterval: "1500", maxIntervalUnit: "ms" }))).toEqual({ maxInterval: 1500 })
  })

  it("四项都填时四项都在", () => {
    const full = form({ limit: "3", interval: "2", intervalUnit: "s", maxInterval: "1", maxIntervalUnit: "m", factor: "1.5" })
    expect(retryOverrideOf(full)).toEqual({ limit: 3, interval: "2s", maxInterval: "1m", factor: 1.5 })
  })

  /*
   * 填错的值原样回送，不在这里拦
   *
   * 判据只该有一处（内核 `api.ts` 的 `retryOverrideOf`）。悄悄丢掉等于把一次填错变成
   * 「这一项跟随全局」，而回送换来内核一句指名到字段的 400。
   */
  it("填错的值原样回送，交内核去报错", () => {
    expect(retryOverrideOf(form({ limit: "五次" }))).toEqual({ limit: "五次" })
    expect(retryOverrideOf(form({ factor: "abc" }))).toEqual({ factor: "abc" })
  })

  it("铺开再收回还是同一份", () => {
    for (const retry of [
      { limit: 0 },
      { limit: 5 },
      { interval: "2s" as const },
      { factor: 2 },
      { limit: 3, interval: 500, maxInterval: "1m" as const, factor: 1.5 }
    ]) {
      expect(retryOverrideOf(retryFormOf(retry))).toEqual(retry)
    }
  })

  /*
   * 往返只保「意思不变」，不保字面不变
   *
   * `"500ms"` 与 `500` 在内核那侧解析成同一个数（`parseDuration` 两种都收），而毫秒一律
   * 复原成数值 —— 那条是为配置页定的：原本写作 `cooldown: 0` 的项若被改写成 `"0ms"`，
   * 看起来像框架在乱改文件。写在这里是为了让下一个读到往返用例的人不必去猜为什么。
   */
  it("\"500ms\" 往返之后成了 500 —— 同一个意思的另一种写法", () => {
    expect(retryOverrideOf(retryFormOf({ interval: "500ms" }))).toEqual({ interval: 500 })
  })
})

describe("有没有自定义", () => {
  it("没填过与填了空对象都算没有", () => {
    // 空对象在内核那侧与「没填」算出的策略一模一样，界面上却会因此多一枚徽标
    expect(isRetryCustom(undefined)).toBe(false)
    expect(isRetryCustom({})).toBe(false)
  })

  it("填了 0 也算有", () => {
    expect(isRetryCustom({ limit: 0 })).toBe(true)
  })
})

describe("摘要", () => {
  it("没有覆盖时一个字都不说", () => {
    expect(retrySummary(undefined)).toBe("")
    expect(retrySummary({})).toBe("")
  })

  it("只列填了的那几项", () => {
    // 把跟随全局的项也列出来就读不出「哪几项是这个号自己的」，而那恰是看这行字的理由
    expect(retrySummary({ limit: 5 })).toBe("最多 5 次")
    expect(retrySummary({ interval: "2s" })).toBe("首次等 2 秒")
  })

  it("limit 为 0 说成「一直重连」，不说「最多 0 次」", () => {
    expect(retrySummary({ limit: 0 })).toBe("一直重连")
  })

  it("四项齐全时以「·」相连", () => {
    expect(retrySummary({ limit: 3, interval: 1500, maxInterval: "1m", factor: 2 })).toBe(
      "最多 3 次 · 首次等 1500 毫秒 · 最长等 1 分 · 倍率 2"
    )
  })
})

describe("「留空即跟随全局」那句", () => {
  it("读不到全局值时退成半句，绝不编一个数上去", () => {
    expect(globalNote("limit", {})).toBe("留空即跟随全局设置")
    expect(globalNote("interval", {})).toBe("留空即跟随全局设置")
  })

  it("读得到就带上那个数", () => {
    expect(globalNote("limit", { limit: 5 })).toBe("留空即跟随全局设置，当前为 5 次")
    expect(globalNote("interval", { interval: "2s" })).toBe("留空即跟随全局设置，当前为 2 秒")
    expect(globalNote("factor", { factor: 2 })).toBe("留空即跟随全局设置，当前为 2")
  })

  it("全局上限为 0 时说清那是「一直重连」", () => {
    // 这是整张表单里最容易被读反的一个值 —— 0 不是「不重连」
    expect(globalNote("limit", { limit: 0 })).toBe("留空即跟随全局设置，当前为 0，即一直重连")
  })
})

describe("从内核配置里挑四项", () => {
  it("只挑这四项，其余一个字节都不留", () => {
    const picked = globalRetryOf({
      server: { token: "绝不该跟着出来的东西", port: 2536 },
      adapter: { reconnectLimit: 3, reconnectInterval: "2s", reconnectMaxInterval: "1m", reconnectFactor: 2 }
    })
    expect(picked).toEqual({ limit: 3, interval: "2s", maxInterval: "1m", factor: 2 })
  })

  it("形状不对的项当缺席 —— 这份 yaml 使用者可以手改", () => {
    const picked = globalRetryOf({
      adapter: { reconnectLimit: "三次", reconnectInterval: "一会儿", reconnectFactor: 2 }
    })
    expect(picked).toEqual({ factor: 2 })
  })

  it("压根没有 adapter 一节时给空对象", () => {
    expect(globalRetryOf({})).toEqual({})
    expect(globalRetryOf({ adapter: null })).toEqual({})
    expect(globalRetryOf({ adapter: [1, 2] })).toEqual({})
    expect(globalRetryOf(undefined)).toEqual({})
    expect(globalRetryOf("我不是配置")).toEqual({})
  })
})
