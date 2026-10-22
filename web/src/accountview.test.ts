import { describe, expect, it } from "vitest"
import { accountTabsOf, accountsOfTab, loginStepOf, loginsOfTab, ORPHAN_TAB, pickAccountTab, qrSrcOf } from "./accountview.js"
import type { AccountItem, AdapterSummary, LoginSnapshot, LoginStep } from "./types.js"

/**
 * 一个适配器
 * @param id 适配器 id
 * @returns 描述
 */
function adapter(id: string): AdapterSummary {
  return { id, name: id.toUpperCase(), platform: "test", accountSchema: { fields: [] } as unknown as AdapterSummary["accountSchema"] }
}

/**
 * 一个账号
 * @param id 账号 id
 * @param adapterId 所属适配器
 * @returns 账号
 */
function account(id: string, adapterId: string): AccountItem {
  return { record: { id, adapterId, enabled: true, config: {} }, status: "online", retries: 0 } as unknown as AccountItem
}

/**
 * 一个登录会话
 * @param id 会话 id
 * @param adapterId 适配器
 * @param status 状态
 * @returns 快照
 */
function session(id: string, adapterId: string, status: LoginSnapshot["status"] = "running"): LoginSnapshot {
  return { id, adapterId, mode: "qr", status, steps: [], startedAt: 0, updatedAt: 0 }
}

const ADAPTERS = [adapter("napcat"), adapter("stdin")]
const ACCOUNTS = [account("a1", "napcat"), account("a2", "stdin"), account("a3", "napcat"), account("a4", "gone")]

describe("accountTabsOf", () => {
  it("每个适配器一枚，按内核给的顺序，计数是名下账号数", () => {
    const tabs = accountTabsOf(ADAPTERS, ACCOUNTS.slice(0, 3))
    expect(tabs).toEqual([
      { id: "napcat", label: "NAPCAT", count: 2 },
      { id: "stdin", label: "STDIN", count: 1 }
    ])
  })

  it("适配器没加载的账号合进最后一枚「未注册」，否则它们在页面上就看不到也删不掉", () => {
    const tabs = accountTabsOf(ADAPTERS, ACCOUNTS)
    expect(tabs.at(-1)).toEqual({ id: ORPHAN_TAB, label: "未注册的适配器", count: 1 })
  })

  it("没有账号的适配器也有页签 —— 加第一个号就从那里加", () => {
    expect(accountTabsOf(ADAPTERS, []).map(t => t.count)).toEqual([0, 0])
  })
})

describe("accountsOfTab", () => {
  it("只取这个适配器的，保持原顺序", () => {
    expect(accountsOfTab("napcat", ADAPTERS, ACCOUNTS).map(a => a.record.id)).toEqual(["a1", "a3"])
  })

  it("「未注册」那枚取适配器不在的", () => {
    expect(accountsOfTab(ORPHAN_TAB, ADAPTERS, ACCOUNTS).map(a => a.record.id)).toEqual(["a4"])
  })
})

describe("pickAccountTab", () => {
  const tabs = accountTabsOf(ADAPTERS, ACCOUNTS)

  it("地址里点名的那枚还在就选它", () => {
    expect(pickAccountTab(tabs, "stdin")).toBe("stdin")
  })

  it("点名的不在（插件卸了、地址抄错）就退回第一枚", () => {
    expect(pickAccountTab(tabs, "qqbot")).toBe("napcat")
    expect(pickAccountTab(tabs, undefined)).toBe("napcat")
  })

  it("一枚都没有时空串", () => {
    expect(pickAccountTab([], "napcat")).toBe("")
  })
})

describe("loginsOfTab", () => {
  it("只摆这个适配器的会话；「未注册」那枚不会有会话", () => {
    const logins = [session("s1", "napcat"), session("s2", "stdin")]
    expect(loginsOfTab("napcat", logins).map(s => s.id)).toEqual(["s1"])
    expect(loginsOfTab(ORPHAN_TAB, logins)).toEqual([])
  })
})

describe("loginStepOf", () => {
  it("没发起是第 0 步，进行中第 1 步，成功三步全勾，失败与取消退回第 0 步", () => {
    expect(loginStepOf(undefined)).toBe(0)
    expect(loginStepOf(session("s", "x", "running"))).toBe(1)
    expect(loginStepOf(session("s", "x", "done"))).toBe(3)
    expect(loginStepOf(session("s", "x", "failed"))).toBe(0)
    expect(loginStepOf(session("s", "x", "cancelled"))).toBe(0)
  })
})

describe("qrSrcOf", () => {
  const qr = (image: Record<string, unknown>): LoginStep => ({ type: "qrcode", image }) as unknown as LoginStep

  it("url 与 base64 直接给", () => {
    expect(qrSrcOf(qr({ kind: "url", url: "https://x/qr.png" }))).toBe("https://x/qr.png")
    expect(qrSrcOf(qr({ kind: "base64", base64: "QUJD", mime: "image/webp" }))).toBe("data:image/webp;base64,QUJD")
  })

  it("JSON 化之后的 buffer 还原成 base64 —— 渲染器出的二维码就是这一形态", () => {
    expect(qrSrcOf(qr({ kind: "buffer", data: { 0: 65, 1: 66, 2: 67 } }))).toBe("data:image/png;base64,QUJD")
  })

  it("本机路径浏览器读不到，给空串让页面改说明", () => {
    expect(qrSrcOf(qr({ kind: "path", path: "C:/qr.png" }))).toBe("")
    expect(qrSrcOf({ type: "info", text: "x" } as unknown as LoginStep)).toBe("")
  })
})
