/**
 * 模块职责：共享刷新节拍的用例
 * 依赖方向：测试文件，依赖 tick.ts
 * 生命周期：一次性
 * 注意事项：**重点是「停表」与「隔离」两条，不是「能收到 tick」。** 收得到 tick 一旦坏了
 *          一眼就看得见；而表没停掉、或一个订阅者抛错拖垮了其余订阅者，两者都不报错，
 *          只表现为「组件移除之后仍在发请求」与「某个插件坏了之后别的插件也不再刷新」。
 *
 *          `tick.ts` 是模块级单例，用例之间共享同一份订阅集，故每个用例必须自行退订
 *          （afterEach 只能兜住漏网的那些，不能替代）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TICK_MS, onTick, tickRunning, tickSubscriberCount } from "./tick.js"

/** 本用例登记的退订函数，afterEach 统一收尾 */
let offs: (() => void)[] = []

/**
 * 订阅并登记退订函数
 * @param fn 回调
 * @returns 退订函数
 */
function sub(fn: () => void): () => void {
  const off = onTick(fn)
  offs.push(off)
  return off
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const off of offs) off()
  offs = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("onTick", () => {
  it("没有订阅者时一条定时器都不存在", () => {
    expect(tickRunning()).toBe(false)
    expect(tickSubscriberCount()).toBe(0)
  })

  it("第一个订阅者到来时起表", () => {
    sub(() => undefined)
    expect(tickRunning()).toBe(true)
    expect(tickSubscriberCount()).toBe(1)
  })

  it("第二个订阅者不再另起一条表 —— 两个插件共用一拍", () => {
    const hits: string[] = []
    sub(() => hits.push("a"))
    sub(() => hits.push("b"))

    expect(tickSubscriberCount()).toBe(2)
    vi.advanceTimersByTime(TICK_MS)

    // 同一拍里两者都被触发，且只触发一次：两条表的话 a 会被触发两次
    expect(hits).toEqual(["a", "b"])
  })

  it("每 TICK_MS 触发一次", () => {
    const fn = vi.fn()
    sub(fn)

    vi.advanceTimersByTime(TICK_MS - 1)
    expect(fn).toHaveBeenCalledTimes(0)

    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TICK_MS * 2)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("订阅本身不触发首轮 —— 首轮由调用方自行发起", () => {
    const fn = vi.fn()
    sub(fn)
    expect(fn).toHaveBeenCalledTimes(0)
  })

  it("退订之后不再被触发", () => {
    const fn = vi.fn()
    const off = sub(fn)

    vi.advanceTimersByTime(TICK_MS)
    expect(fn).toHaveBeenCalledTimes(1)

    off()
    vi.advanceTimersByTime(TICK_MS * 3)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("最后一个退订时停表，不留下空转的定时器", () => {
    const off1 = sub(() => undefined)
    const off2 = sub(() => undefined)

    off1()
    // 还剩一个订阅者，表须继续走
    expect(tickRunning()).toBe(true)

    off2()
    expect(tickRunning()).toBe(false)
    expect(tickSubscriberCount()).toBe(0)
  })

  it("重复退订无害", () => {
    const fn = vi.fn()
    const off = sub(fn)

    off()
    off()
    expect(tickRunning()).toBe(false)

    // 另起一个订阅者，前一个的重复退订不应把它一起停掉
    sub(() => undefined)
    expect(tickRunning()).toBe(true)
    expect(tickSubscriberCount()).toBe(1)
  })

  it("停表后再订阅会重新起表", () => {
    const off = sub(() => undefined)
    off()
    expect(tickRunning()).toBe(false)

    const fn = vi.fn()
    sub(fn)
    vi.advanceTimersByTime(TICK_MS)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("一个订阅者抛错不影响同一拍上的其余订阅者", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const after = vi.fn()

    sub(() => {
      throw new Error("这个插件的取数炸了")
    })
    sub(after)

    vi.advanceTimersByTime(TICK_MS)
    expect(after).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledTimes(1)

    // 且下一拍照常继续，抛错的那个订阅者不会被自动摘掉
    vi.advanceTimersByTime(TICK_MS)
    expect(after).toHaveBeenCalledTimes(2)
    expect(errors).toHaveBeenCalledTimes(2)
  })

  it("回调里退订自己不影响本拍其余订阅者", () => {
    const other = vi.fn()
    // 退订函数装在一个持有者里：回调要在它被赋值之前就引用它，
    // 而那正是「组件在第一拍里就把自己卸掉」的实情
    const holder: { off?: () => void } = {}
    const self = vi.fn(() => holder.off?.())

    holder.off = sub(self)
    sub(other)

    vi.advanceTimersByTime(TICK_MS)
    // 迭代的是订阅集的副本，故 other 仍在本拍内被触发
    expect(other).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TICK_MS)
    expect(self).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(2)
  })
})
