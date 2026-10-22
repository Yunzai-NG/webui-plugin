import { describe, expect, it } from "vitest"
import { CLASSIC, firstPaintOf, pickTheme, slotVarsOf, themeMessageOf, type ThemeInfo } from "./themeview.js"

/** 一款带边框、开关表情与分明暗背景的主题 */
const AYAKA: ThemeInfo = {
  ...CLASSIC,
  id: "ayaka",
  name: "绫华",
  builtin: false,
  style: "/plugin/webui/theme/ayaka/theme.css",
  slots: {
    "switch.thumb.on": "/plugin/webui/theme/ayaka/on.png",
    "frame.card": { image: "/plugin/webui/theme/ayaka/f.png", slice: 40, width: "20px", outset: "4px", repeat: "round" },
    backdrop: { light: "/plugin/webui/theme/ayaka/bl.webp", dark: "/plugin/webui/theme/ayaka/bd.webp" }
  }
}

describe("slotVarsOf", () => {
  it("每个槽位一组变量，并列出槽位名供 data-slots 用", () => {
    const { vars, names } = slotVarsOf(AYAKA.slots, "light")
    expect(names).toEqual(["switch.thumb.on", "frame.card", "backdrop"])
    expect(vars["--slot-switch-thumb-on"]).toBe('url("/plugin/webui/theme/ayaka/on.png")')
    expect(vars["--slot-frame-card-slice"]).toBe("40")
    expect(vars["--slot-frame-card-outset"]).toBe("4px")
    expect(vars["--slot-frame-card-repeat"]).toBe("round")
  })

  it("背景图按明暗取，只给一张时两种都用它", () => {
    expect(slotVarsOf(AYAKA.slots, "dark").vars["--slot-backdrop"]).toBe('url("/plugin/webui/theme/ayaka/bd.webp")')
    const one = slotVarsOf({ backdrop: { light: "/a.webp" } }, "dark")
    expect(one.vars["--slot-backdrop"]).toBe('url("/a.webp")')
  })

  it("地址里的引号与反斜杠被剔掉，拼不出第二个声明", () => {
    const { vars } = slotVarsOf({ empty: '/a.png") ; --x: url("y' }, "light")
    // 只剩外层那一对引号：里面的引号被剔掉，就闭合不了 url() 去接下一个声明
    expect(vars["--slot-empty"]).toMatch(/^url\("[^"\\]*"\)$/)
  })
})

describe("firstPaintOf", () => {
  it("经典没有样式表，只带空变量", () => {
    expect(firstPaintOf(CLASSIC, "light")).toEqual({ id: "classic", vars: {}, slots: "", schemes: ["light", "dark"] })
  })

  it("带上样式表与槽位", () => {
    const got = firstPaintOf(AYAKA, "light")
    expect(got.css).toBe(AYAKA.style)
    expect(got.slots).toBe("switch.thumb.on frame.card backdrop")
  })
})

describe("pickTheme", () => {
  const list = [CLASSIC, AYAKA]

  it("所选的在表里就用它", () => {
    expect(pickTheme(list, "ayaka", "classic").id).toBe("ayaka")
  })

  it("所选的被卸掉了：先退站点默认，再退经典", () => {
    expect(pickTheme(list, "gone", "ayaka").id).toBe("ayaka")
    expect(pickTheme(list, "gone", "nope").id).toBe("classic")
  })

  it("主题表是空的（取不到）也有经典兜底", () => {
    expect(pickTheme([], "ayaka", "classic")).toBe(CLASSIC)
  })
})

describe("themeMessageOf", () => {
  it("地址补成绝对的，背景按明暗取一张", () => {
    const msg = themeMessageOf({ theme: AYAKA, scheme: "dark", tokens: { "--accent": "red" }, origin: "http://127.0.0.1:2536", lowPower: false, motion: true })
    expect(msg.kind).toBe("yunzai-ng.theme")
    expect(msg.css).toBe("http://127.0.0.1:2536/plugin/webui/theme/ayaka/theme.css")
    expect(msg.slots.backdrop).toBe("http://127.0.0.1:2536/plugin/webui/theme/ayaka/bd.webp")
    expect(msg.slots["frame.card"]).toBe("http://127.0.0.1:2536/plugin/webui/theme/ayaka/f.png")
  })

  it("经典不带样式表", () => {
    const msg = themeMessageOf({ theme: CLASSIC, scheme: "light", tokens: {}, origin: "http://x", lowPower: true, motion: false })
    expect(msg.css).toBeUndefined()
    expect(msg.lowPower).toBe(true)
  })
})
