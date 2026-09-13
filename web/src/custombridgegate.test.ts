/**
 * 模块职责：钉住只读桥的放行与拒绝边界
 * 依赖方向：测试文件，只依赖 custombridgegate
 * 生命周期：无
 * 注意事项：这条桥是插件页面取数的唯一通道，放宽一点就等于把面板令牌交出去（见被测模块的文件头）。
 *          故用例的重点不是「能取到数」，而是**取不到的那些确实取不到**：配置、别家插件的接口、
 *          走出自己前缀的路径。收发那半截在 `custombridge.ts`，要 `window` 与 iframe，
 *          用例跑在 node 环境（无 jsdom）测不到 —— 它只是把这里的判定原样执行。
 */
import { describe, it, expect } from "vitest"
import { judgeRequest, allowedPaths } from "./custombridgegate.js"

/** 一条合规的请求外壳，各用例只改自己关心的字段 */
const ask = (extra: Record<string, unknown>): Record<string, unknown> => ({ kind: "yunzai-ng.custom", id: 1, ...extra })

describe("judgeRequest", () => {
  it("放行白名单内的面板接口", () => {
    for (const path of allowedPaths()) {
      expect(judgeRequest(ask({ path }), "demo")).toEqual({ act: "panel", path })
    }
  })

  it("不是本桥的消息一概不理", () => {
    // 回错误会打扰页面自己的 postMessage：iframe 里可能有别的库在用同一条通道
    expect(judgeRequest(ask({ kind: "other", path: "overview" }), "demo")).toEqual({ act: "ignore" })
    expect(judgeRequest(null, "demo")).toEqual({ act: "ignore" })
    expect(judgeRequest("overview", "demo")).toEqual({ act: "ignore" })
    expect(judgeRequest(undefined, "demo")).toEqual({ act: "ignore" })
  })

  it("配置不在白名单里", () => {
    // 内核的 GET config/:name 刻意不脱敏，带着面板令牌与适配器的连接密钥
    for (const path of ["config", "config/yunzai", "config/adapter-napcat"]) {
      expect(judgeRequest(ask({ path }), "demo").act).toBe("deny")
    }
    expect(allowedPaths().some(item => item.startsWith("config"))).toBe(false)
  })

  it("白名单按全集匹配，前缀相同也不放行", () => {
    // 前缀匹配的话 `server` 会连带放行 `server/token` 一类
    for (const path of ["overview/detail", "server/token", "plugins/demo/config"]) {
      expect(judgeRequest(ask({ path }), "demo").act).toBe("deny")
    }
  })

  it("路径缺失或不是字符串时拒掉，且错误里说清是空", () => {
    const got = judgeRequest(ask({}), "demo")
    expect(got.act).toBe("deny")
    expect(got.act === "deny" && got.error).toContain("(空)")
    expect(judgeRequest(ask({ path: 42 }), "demo").act).toBe("deny")
  })

  it("self 请求落在本插件自己的前缀下", () => {
    expect(judgeRequest(ask({ path: "stats", self: true }), "demo")).toEqual({
      act: "self",
      url: "/plugin/webui/custom/demo/api/stats"
    })
  })

  it("self 请求用的插件标识是外壳给的，不认页面自报的", () => {
    // 页面填别人的名字也没用：拼前缀只看第二个参数
    const got = judgeRequest(ask({ path: "stats", self: true, plugin: "victim" }), "demo")
    expect(got).toEqual({ act: "self", url: "/plugin/webui/custom/demo/api/stats" })
  })

  it("self 请求挡下走出自己前缀的路径", () => {
    for (const path of ["../../config/yunzai", "..", "a/../../b", "has space", "中文", "?q=1", ""]) {
      const got = judgeRequest(ask({ path, self: true }), "demo")
      expect(got.act, path).toBe("deny")
      expect(got.act === "deny" && got.error, path).toContain("不合法")
    }
  })

  it("self 请求的前导斜杠按服务端那套剥掉，两种写法同指一处", () => {
    // 服务端 registerApi 也剥（见 src/custompage.ts）：插件写 `/stats` 注册得上，
    // 页面照抄 `/stats` 却拼出 `…/api//stats` 打不中，才是真会咬人的那种不一致
    const bare = judgeRequest(ask({ path: "stats", self: true }), "demo")
    const slashed = judgeRequest(ask({ path: "/stats", self: true }), "demo")
    expect(slashed).toEqual(bare)
    expect(judgeRequest(ask({ path: "//stats", self: true }), "demo")).toEqual(bare)
  })

  it("插件标识还没到手时拒掉 self，并说明可重试", () => {
    const got = judgeRequest(ask({ path: "stats", self: true }), "")
    expect(got.act).toBe("deny")
    expect(got.act === "deny" && got.error).toContain("稍后再试")
  })

  it("self 只认布尔真，别的值一律当面板请求", () => {
    // `self: "1"` 这类写法若当真处理，白名单便被一个手滑绕开了
    expect(judgeRequest(ask({ path: "overview", self: "1" }), "demo")).toEqual({ act: "panel", path: "overview" })
    expect(judgeRequest(ask({ path: "stats", self: 1 }), "demo").act).toBe("deny")
  })

  it("配置编辑默认关闭，iframe 自报授权无效", () => {
    expect(judgeRequest(ask({ config: true, configurable: true }), "demo").act).toBe("deny")
    expect(judgeRequest(ask({ config: true }), "demo", true)).toEqual({ act: "config", method: "GET", path: "config/demo" })
  })

  it("只允许本插件配置 GET/PATCH，不能指定其他配置名", () => {
    expect(judgeRequest(ask({ config: true, plugin: "victim", method: "PATCH", body: { enable: false } }), "demo", true))
      .toEqual({ act: "config", method: "PATCH", path: "config/demo", body: { enable: false } })
    for (const extra of [
      { path: "config/yunzai" }, { self: true }, { method: "DELETE" },
      { method: "PATCH", body: [] }, { method: "PATCH", body: null }
    ]) expect(judgeRequest(ask({ config: true, ...extra }), "demo", true).act).toBe("deny")
    for (const name of ["", "yunzai", "YUNZAI", "../yunzai", "demo/other"]) {
      expect(judgeRequest(ask({ config: true }), name, true).act).toBe("deny")
    }
  })

  it("开放本插件配置不放开普通白名单或 self 写入", () => {
    expect(judgeRequest(ask({ path: "config/yunzai" }), "demo", true).act).toBe("deny")
    expect(judgeRequest(ask({ path: "accounts", method: "POST" }), "demo", true).act).toBe("deny")
    expect(judgeRequest(ask({ path: "stats", self: true, method: "PATCH" }), "demo", true).act).toBe("deny")
  })

  it("白名单是拷贝，改不动桥里那份", () => {
    const first = allowedPaths() as string[]
    first.length = 0
    expect(allowedPaths().length).toBeGreaterThan(0)
  })
})
