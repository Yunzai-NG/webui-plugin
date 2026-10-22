import { describe, expect, it } from "vitest"
import { fitScheme, nextScheme, readSchemeChoice, resolveScheme, type SchemeChoice } from "./scheme.js"

/*
 * 只测纯函数
 *
 * `initScheme` 与 `cycleScheme` 要 document / localStorage / matchMedia，而本仓库的
 * 用例环境是 node（见 vitest.config.ts 的注释）—— 真正会算错的也是这几个：
 * 三态轮转与「跟随系统」的解析写反了不报错，只表现为「点了明暗按钮没反应」。
 */
describe("readSchemeChoice", () => {
  it("认得两个显式取值", () => {
    expect(readSchemeChoice("light")).toBe("light")
    expect(readSchemeChoice("dark")).toBe("dark")
  })

  it("没存过时是跟随系统", () => {
    expect(readSchemeChoice(null)).toBe("auto")
  })

  it("认不得的值退回跟随系统而不是抛错", () => {
    // 手改坏了、或旧版留下的取值：这一项坏掉不该让面板打不开
    expect(readSchemeChoice("auto")).toBe("auto")
    expect(readSchemeChoice("")).toBe("auto")
    expect(readSchemeChoice("Dark")).toBe("auto")
    expect(readSchemeChoice("{}")).toBe("auto")
  })
})

describe("resolveScheme", () => {
  it("跟随系统时听系统的", () => {
    expect(resolveScheme("auto", true)).toBe("dark")
    expect(resolveScheme("auto", false)).toBe("light")
  })

  it("显式选过之后不受系统偏好影响", () => {
    // 这一条是三态存在的理由：已选浅色的人在深色系统上仍该看到浅色
    expect(resolveScheme("light", true)).toBe("light")
    expect(resolveScheme("dark", false)).toBe("dark")
  })
})

describe("nextScheme", () => {
  it("三态首尾相接，转三次回到原处", () => {
    expect(nextScheme("auto")).toBe("light")
    expect(nextScheme("light")).toBe("dark")
    expect(nextScheme("dark")).toBe("auto")
  })

  it("从任一态出发都走得回来", () => {
    for (const start of ["auto", "light", "dark"] as SchemeChoice[]) {
      expect(nextScheme(nextScheme(nextScheme(start)))).toBe(start)
    }
  })
})

describe("fitScheme", () => {
  it("主题两套都给时照使用者的选", () => {
    expect(fitScheme("dark", ["light", "dark"])).toBe("dark")
    expect(fitScheme("light", ["light", "dark"])).toBe("light")
  })

  it("主题只给一套时用那一套", () => {
    // 强行套一套主题没设计过的令牌，得到的是没人见过的颜色
    expect(fitScheme("dark", ["light"])).toBe("light")
    expect(fitScheme("light", ["dark"])).toBe("dark")
  })

  it("没声明按两套都支持算", () => {
    expect(fitScheme("dark", [])).toBe("dark")
  })
})
