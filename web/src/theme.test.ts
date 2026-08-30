import { describe, expect, it } from "vitest"
import { nextTheme, readThemeChoice, resolveTheme, type ThemeChoice } from "./theme.js"

/*
 * 只测三个纯函数
 *
 * `initTheme` 与 `cycleTheme` 要 document / localStorage / matchMedia，而本仓库的
 * 用例环境是 node（见 vitest.config.ts 的注释）—— 真正会算错的也是这三个：
 * 三态轮转与「跟随系统」的解析写反了不报错，只表现为「点了主题按钮没反应」。
 */
describe("readThemeChoice", () => {
  it("认得两个显式取值", () => {
    expect(readThemeChoice("light")).toBe("light")
    expect(readThemeChoice("dark")).toBe("dark")
  })

  it("没存过时是跟随系统", () => {
    expect(readThemeChoice(null)).toBe("auto")
  })

  it("认不得的值退回跟随系统而不是抛错", () => {
    // 手改坏了、或旧版留下的取值：这一项坏掉不该让面板打不开
    expect(readThemeChoice("auto")).toBe("auto")
    expect(readThemeChoice("")).toBe("auto")
    expect(readThemeChoice("Dark")).toBe("auto")
    expect(readThemeChoice("{}")).toBe("auto")
  })
})

describe("resolveTheme", () => {
  it("跟随系统时听系统的", () => {
    expect(resolveTheme("auto", true)).toBe("dark")
    expect(resolveTheme("auto", false)).toBe("light")
  })

  it("显式选过之后不受系统偏好影响", () => {
    // 这一条是三态存在的理由：已选浅色的人在深色系统上仍该看到浅色
    expect(resolveTheme("light", true)).toBe("light")
    expect(resolveTheme("dark", false)).toBe("dark")
  })
})

describe("nextTheme", () => {
  it("三态首尾相接，转三次回到原处", () => {
    expect(nextTheme("auto")).toBe("light")
    expect(nextTheme("light")).toBe("dark")
    expect(nextTheme("dark")).toBe("auto")
  })

  it("从任一态出发都走得回来", () => {
    for (const start of ["auto", "light", "dark"] as ThemeChoice[]) {
      expect(nextTheme(nextTheme(nextTheme(start)))).toBe(start)
    }
  })
})
