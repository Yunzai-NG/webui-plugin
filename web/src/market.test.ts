/**
 * 模块职责：`market.ts` 的用例 —— 三种取源结果各自的文案
 * 依赖方向：测试文件，只依赖被测模块与类型
 * 生命周期：纯函数，无夹具
 * 注意事项：断言逐条落在**使用者据此会做什么**上，而非文案的字面。三种结果分别对应三种
 *          后续动作：拉到新提交 —— 看版本号；已是最新 —— 什么都不必做；整目录重装 ——
 *          目录里的依赖已随旧目录没了。故每条都验「不该出现的那句确实没出现」。
 */
import { describe, expect, it } from "vitest"
import { resultText } from "./market.js"
import type { MarketInstallResult } from "./types.js"

/**
 * 造一份接口返回
 * @param over 覆盖字段
 * @returns 返回值
 */
function make(over: Partial<MarketInstallResult> = {}): MarketInstallResult {
  return {
    name: "demo",
    dir: "/opt/yunzai/plugins/demo",
    via: "pull",
    version: "1.1.0",
    needsDependencies: false,
    unloaded: false,
    loaded: ["demo"],
    ...over
  }
}

describe("就地拉取", () => {
  it("拉到新提交时给出版本迁移，并说明依赖未动", () => {
    const text = resultText(make({ changed: true, fromVersion: "1.0.0" }))
    expect(text).toContain("1.0.0 → 1.1.0")
    expect(text).toContain("依赖未被动过")
  })

  it("**已是最新时不能说「已更新」** —— 否则使用者会去找那个并不存在的变化", () => {
    const text = resultText(make({ changed: false, fromVersion: "1.1.0" }))
    expect(text).toContain("已是最新版本 1.1.0")
    expect(text).toContain("没有新提交")
    expect(text).not.toContain("已就地更新")
  })

  it("旧版本号缺失或与新版本相同时只报一个版本，不写出「1.1.0 → 1.1.0」", () => {
    expect(resultText(make({ changed: true }))).toContain("已就地更新：1.1.0。")
    expect(resultText(make({ changed: true, fromVersion: "1.1.0" }))).toContain("已就地更新：1.1.0。")
  })

  it("拉来的新版本新增了依赖时同样提示，并给出目录", () => {
    const text = resultText(make({ changed: true, fromVersion: "1.0.0", needsDependencies: true }))
    expect(text).toContain("/opt/yunzai/plugins/demo")
    expect(text).toContain("pnpm install")
  })

  it("已是最新但缺依赖时也提示 —— 这一条与拉没拉到东西无关", () => {
    const text = resultText(make({ changed: false, needsDependencies: true }))
    expect(text).toContain("已是最新版本")
    expect(text).toContain("pnpm install")
  })
})

describe("整目录安装", () => {
  it("git 克隆与归档下载都按「已安装并加载」说", () => {
    expect(resultText(make({ via: "git" }))).toBe("demo 1.1.0 已安装并加载。")
    expect(resultText(make({ via: "tarball" }))).toBe("demo 1.1.0 已安装并加载。")
  })

  it("缺依赖时不说「已加载」 —— 缺依赖的插件加载必然失败", () => {
    const text = resultText(make({ via: "git", needsDependencies: true }))
    expect(text).toContain("已安装。")
    expect(text).not.toContain("已加载")
    expect(text).toContain("pnpm install")
  })

  it("**不提「依赖未被动过」** —— 整目录替换时那份 node_modules 已经没了", () => {
    expect(resultText(make({ via: "tarball" }))).not.toContain("依赖未被动过")
  })
})
