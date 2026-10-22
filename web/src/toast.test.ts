/**
 * 模块职责：`toast.ts` 的用例 —— 时长怎么算、同文案怎么并、上限怎么丢
 * 依赖方向：测试文件，只依赖 toast.ts 本身（它不碰 DOM，也不碰 api）
 * 生命周期：每条用例前清空那一摞
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  TOAST_ACTION_MIN_MS,
  TOAST_MAX,
  TOAST_MAX_MS,
  TOAST_MIN_MS,
  TOAST_STAGGER_MS,
  dismissToast,
  runToastAction,
  showToast,
  toastDurationOf,
  toasts
} from "./toast.js"

beforeEach(() => {
  toasts.value = []
})

describe("toastDurationOf", () => {
  it("短回执取下限", () => {
    expect(toastDurationOf("已保存")).toBe(TOAST_MIN_MS)
  })

  it("长回执按字数加时", () => {
    const long = "已".repeat(60)
    expect(toastDurationOf(long)).toBeGreaterThan(TOAST_MIN_MS)
    expect(toastDurationOf(long)).toBeLessThanOrEqual(TOAST_MAX_MS)
  })

  it("再长也夹在上限内 —— 否则一条几百字的回执会把条子钉在页面顶上", () => {
    expect(toastDurationOf("已".repeat(5000))).toBe(TOAST_MAX_MS)
  })
})

describe("showToast", () => {
  it("提示一条，文案与时长对得上", () => {
    showToast("已保存 plugin:demo")
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.text).toBe("已保存 plugin:demo")
    expect(toasts.value[0]?.ms).toBe(toastDurationOf("已保存 plugin:demo"))
  })

  it("空串与纯空白不提示 —— 调用方常把「清掉上一条」写成传空串", () => {
    showToast("")
    showToast("   ")
    expect(toasts.value).toHaveLength(0)
  })

  it("文案前后的空白削掉", () => {
    showToast("  已保存  ")
    expect(toasts.value[0]?.text).toBe("已保存")
  })

  it("**同文案不叠，换掉原先那条**：连点两下保存不表示发生了两件事", () => {
    showToast("已保存")
    const first = toasts.value[0]?.id
    showToast("已保存")
    expect(toasts.value).toHaveLength(1)
    // 换了 id，故 ToastItem 重挂、计时从头开始
    expect(toasts.value[0]?.id).not.toBe(first)
  })

  it("不同文案各占一条，最新的在最后", () => {
    showToast("已保存 a")
    showToast("已保存 b")
    expect(toasts.value.map(one => one.text)).toEqual(["已保存 a", "已保存 b"])
  })

  it("超出上限时丢最旧的那条", () => {
    for (let i = 0; i < TOAST_MAX + 2; i += 1) showToast(`第 ${i} 条`)
    expect(toasts.value).toHaveLength(TOAST_MAX)
    expect(toasts.value[0]?.text).toBe("第 2 条")
    expect(toasts.value[TOAST_MAX - 1]?.text).toBe(`第 ${TOAST_MAX + 1} 条`)
  })

  it("每条的 id 互不相同 —— 它同时是 `:key`", () => {
    showToast("a")
    showToast("b")
    showToast("c")
    expect(new Set(toasts.value.map(one => one.id)).size).toBe(3)
  })
})

describe("showToast 的错开到点", () => {
  it("等长的几条挨个让位，相邻到点至少隔一个错开间隔 —— 否则一摞会齐齐消失", () => {
    showToast("甲")
    showToast("乙")
    showToast("丙")
    const dues = toasts.value.map(one => one.dueAt).sort((a, b) => a - b)
    expect(dues).toHaveLength(3)
    for (let i = 1; i < dues.length; i += 1) {
      expect((dues[i] ?? 0) - (dues[i - 1] ?? 0)).toBeGreaterThanOrEqual(TOAST_STAGGER_MS)
    }
  })

  it("让位加的时长记在 `ms` 上 —— 进度条与计时同取这个数，两者不能各算一套", () => {
    showToast("甲")
    showToast("乙")
    const second = toasts.value[1]
    expect(second?.ms).toBeGreaterThan(toastDurationOf("乙"))
    expect(second?.ms).toBeGreaterThanOrEqual(TOAST_STAGGER_MS)
  })

  it("**本就错开得够远时不动**：短回执不必陪着前一条长回执站十几秒", () => {
    showToast("已".repeat(100))
    showToast("已复制值")
    expect(toasts.value[1]?.ms).toBe(toastDurationOf("已复制值"))
  })

  it("只跟在场的比，被丢掉的那条不再占位", () => {
    for (let i = 0; i < TOAST_MAX + 1; i += 1) showToast(`第 ${i} 条`)
    const dues = toasts.value.map(one => one.dueAt).sort((a, b) => a - b)
    // 四条等长文案依次让位，若把已丢掉的「第 0 条」也算进去，最后一条要多挪出一个间隔
    expect((dues[dues.length - 1] ?? 0) - (dues[0] ?? 0)).toBe(2 * TOAST_STAGGER_MS)
  })
})

describe("dismissToast", () => {
  it("带动作的条子至少停留 8 秒，点动作钮先收起再执行", async () => {
    let ran = 0
    showToast("已删除 a", { label: "撤销", run: () => void ran++ })
    const one = toasts.value.at(-1)
    expect(one?.action).toBe("撤销")
    expect(one?.ms).toBeGreaterThanOrEqual(TOAST_ACTION_MIN_MS)
    await runToastAction(one?.id ?? -1)
    expect(ran).toBe(1)
    expect(toasts.value.some(t => t.id === one?.id)).toBe(false)
    // 已收起的再点一次不会重复执行
    await runToastAction(one?.id ?? -1)
    expect(ran).toBe(1)
  })

  it("只收起指定那一条", () => {
    showToast("a")
    showToast("b")
    const id = toasts.value[0]?.id ?? 0
    dismissToast(id)
    expect(toasts.value.map(one => one.text)).toEqual(["b"])
  })

  it("收起不存在的标识无副作用", () => {
    showToast("a")
    dismissToast(9999)
    expect(toasts.value).toHaveLength(1)
  })
})
