/**
 * 模块职责：`market.ts` 的用例 —— 三种取源结果、两种失败与「刚装过依赖」各自的文案
 * 依赖方向：测试文件，只依赖被测模块与类型
 * 生命周期：纯函数，无夹具
 * 注意事项：断言逐条落在**使用者据此会做什么**上，而非文案的字面。三种取源结果对应三种
 *          后续动作：拉到新提交 —— 看版本号；已是最新 —— 什么都不必做；整目录重装 ——
 *          目录里的依赖已随旧目录没了。故每条都验「不该出现的那句确实没出现」。
 *
 *          **「已加载」那半句按 `loaded` 判，不按 `needsDependencies` 反推。** 内核有三种
 *          情形不加载（缺依赖、依赖装失败、装后步骤失败），前端若自行推断，迟早与内核那侧
 *          的判据错开，而错开的表现是界面说「已加载」而插件其实没跑。
 */
import { describe, expect, it } from "vitest"
import { resultText, setupResultText } from "./market.js"
import type { MarketInstallResult, MarketSetupResult } from "./types.js"

/**
 * 造一份安装或更新的返回
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

/**
 * 造一份单独收尾的返回
 * @param over 覆盖字段
 * @returns 返回值
 */
function setupOf(over: Partial<MarketSetupResult> = {}): MarketSetupResult {
  return {
    name: "demo",
    dir: "/opt/yunzai/plugins/demo",
    version: "1.0.0",
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

  it("拉来的新版本新增了依赖而没装上时同样提示，并给出目录", () => {
    const text = resultText(make({ changed: true, fromVersion: "1.0.0", needsDependencies: true, loaded: [] }))
    expect(text).toContain("/opt/yunzai/plugins/demo")
    expect(text).toContain("pnpm install")
  })

  it("已是最新但缺依赖时也提示 —— 这一条与拉没拉到东西无关", () => {
    const text = resultText(make({ changed: false, needsDependencies: true, loaded: [] }))
    expect(text).toContain("已是最新版本")
    expect(text).toContain("pnpm install")
  })
})

describe("整目录安装", () => {
  it("git 克隆与归档下载都按「已安装并加载」说", () => {
    expect(resultText(make({ via: "git" }))).toBe("demo 1.1.0 已安装并加载。")
    expect(resultText(make({ via: "tarball" }))).toBe("demo 1.1.0 已安装并加载。")
  })

  it("**不提「依赖未被动过」** —— 整目录替换时那份 node_modules 已经没了", () => {
    expect(resultText(make({ via: "tarball" }))).not.toContain("依赖未被动过")
  })

  it("**没加载成功就不说「已加载」** —— 判据是 loaded，不是缺不缺依赖", () => {
    const text = resultText(make({ via: "git", loaded: [] }))
    expect(text).toContain("已安装。")
    expect(text).not.toContain("已加载")
  })
})

describe("代跑包管理器之后", () => {
  it("装好了依赖要说出来 —— 一次几分钟的等待不该在界面上毫无交代", () => {
    const text = resultText(make({ via: "git", installedDeps: true, packageManager: "pnpm", ranScripts: [] }))
    expect(text).toContain("依赖已由 pnpm 装好")
  })

  it("跑过装后步骤时逐个列出，使用者据此知道 build 确实跑了", () => {
    const text = resultText(
      make({ via: "git", installedDeps: true, packageManager: "pnpm", ranScripts: ["build", "install:browser"] })
    )
    expect(text).toContain("并执行了 build、install:browser")
  })

  it("既没装也不缺时不添任何一句 —— 那是「本来就没有依赖」", () => {
    expect(resultText(make({ via: "git" }))).toBe("demo 1.1.0 已安装并加载。")
  })

  it("**两种失败分开说**：依赖装不上指向包管理器，装后步骤失败指向那个 script", () => {
    const dep = resultText(make({ via: "git", loaded: [], dependencyError: "ETIMEDOUT", packageManager: "npm" }))
    expect(dep).toContain("依赖安装失败：ETIMEDOUT")
    expect(dep).toContain("npm install")
    expect(dep).not.toContain("装后步骤")

    const built = resultText(
      make({ via: "git", loaded: [], installedDeps: true, setupError: "build：tsc 报错", ranScripts: [] })
    )
    expect(built).toContain("装后步骤失败：build：tsc 报错")
    expect(built).not.toContain("依赖安装失败")
  })

  it("装依赖失败时不再重复「声明了运行时依赖」 —— 那一句在此处是废话", () => {
    const text = resultText(make({ via: "git", loaded: [], needsDependencies: true, dependencyError: "ETIMEDOUT" }))
    expect(text).toContain("依赖安装失败")
    expect(text).not.toContain("声明了运行时依赖")
  })
})

describe("单独发起的收尾", () => {
  it("装好并重载时两件事都说", () => {
    const text = setupResultText(setupOf({ installedDeps: true, packageManager: "pnpm", ranScripts: ["build"] }))
    expect(text).toContain("依赖已由 pnpm 装好，并执行了 build")
    expect(text).toContain("已重新加载")
  })

  it("**没有依赖可装时要明说**，否则点了按钮像是什么都没发生", () => {
    expect(setupResultText(setupOf())).toContain("没有声明依赖")
  })

  it("失败时不说「已重新加载」", () => {
    const text = setupResultText(setupOf({ loaded: [], dependencyError: "ETIMEDOUT" }))
    expect(text).toContain("依赖安装失败")
    expect(text).not.toContain("已重新加载")
  })
})
