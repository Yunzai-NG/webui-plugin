import { describe, expect, it } from "vitest"
import {
  COLOR_PRESETS,
  CUSTOM,
  DEFAULT_VALUES,
  LAYOUT_KEYS,
  LAYOUT_PRESETS,
  colorPresetOf,
  cssVariablesOf,
  layoutPresetOf,
  readAppearance,
  sanitizeValues
} from "./appearance.js"

/*
 * 只测纯函数
 *
 * `initAppearance` 要 document / localStorage，用例环境是 node。会悄悄算错的是这几处：
 * 落盘数据的校验与旧格式兼容、由取值反推方案、参数到 CSS 变量的换算。
 */
describe("readAppearance", () => {
  it("没存过时取默认", () => {
    expect(readAppearance(null)).toEqual(DEFAULT_VALUES)
    expect(readAppearance("")).toEqual(DEFAULT_VALUES)
  })

  it("坏 JSON 退回默认", () => {
    expect(readAppearance("{oops")).toEqual(DEFAULT_VALUES)
  })

  it("新格式按 values 读，缺项补默认", () => {
    expect(readAppearance(JSON.stringify({ values: { radius: "large" } }))).toEqual({ ...DEFAULT_VALUES, radius: "large" })
  })

  it("兼容旧版 { preset, custom }", () => {
    const read = readAppearance(JSON.stringify({ preset: "compact", custom: { accentHue: 18 } }))
    expect(read.radius).toBe("small")
    expect(read.accentHue).toBe(18)
    expect(readAppearance(JSON.stringify({ preset: "ocean" }))).toEqual(DEFAULT_VALUES)
  })
})

describe("sanitizeValues", () => {
  it("丢掉非法取值与未知键", () => {
    expect(sanitizeValues({ radius: "huge", density: "compact", evil: "x" })).toEqual({ density: "compact" })
  })

  it("色相取整并夹在 0–360", () => {
    expect(sanitizeValues({ accentHue: 400 })).toEqual({ accentHue: 360 })
    expect(sanitizeValues({ accentHue: -5 })).toEqual({ accentHue: 0 })
    expect(sanitizeValues({ accentHue: 12.6 })).toEqual({ accentHue: 13 })
    expect(sanitizeValues({ accentHue: Number.NaN })).toEqual({})
  })

  it("玻璃拟态只认布尔", () => {
    expect(sanitizeValues({ glassEffect: "yes" })).toEqual({})
    expect(sanitizeValues({ glassEffect: true })).toEqual({ glassEffect: true })
  })

  it("非对象输入得到空对象", () => {
    expect(sanitizeValues(null)).toEqual({})
    expect(sanitizeValues("x")).toEqual({})
  })
})

describe("方案", () => {
  it("标识与色相不重复", () => {
    expect(new Set(LAYOUT_PRESETS.map(p => p.id)).size).toBe(LAYOUT_PRESETS.length)
    expect(new Set(COLOR_PRESETS.map(p => p.hue)).size).toBe(COLOR_PRESETS.length)
  })

  it("视觉方案只含形的参数，不含强调色与动效", () => {
    for (const p of LAYOUT_PRESETS) expect(Object.keys(p.values).sort()).toEqual([...LAYOUT_KEYS].sort())
  })

  it("默认取值落在「默认」视觉方案与首个配色方案上", () => {
    expect(layoutPresetOf(DEFAULT_VALUES)).toBe("default")
    expect(colorPresetOf(DEFAULT_VALUES)).toBe(COLOR_PRESETS[0]?.id)
  })

  it("两类方案互不干扰", () => {
    const compact = { ...DEFAULT_VALUES, ...LAYOUT_PRESETS.find(p => p.id === "compact")?.values, accentHue: 152 }
    expect(layoutPresetOf(compact)).toBe("compact")
    expect(colorPresetOf(compact)).toBe("forest")
    expect(layoutPresetOf({ ...DEFAULT_VALUES, motion: "off" })).toBe("default")
  })

  it("对不上任何方案时为自定义", () => {
    expect(layoutPresetOf({ ...DEFAULT_VALUES, radius: "large" })).toBe(CUSTOM)
    expect(colorPresetOf({ ...DEFAULT_VALUES, accentHue: 7 })).toBe(CUSTOM)
  })
})

describe("cssVariablesOf", () => {
  it("默认参数与 styles.css 的 :root 一致", () => {
    const vars = cssVariablesOf(DEFAULT_VALUES)
    expect(vars["--r-card"]).toBe("14px")
    expect(vars["--s4"]).toBe("16px")
    expect(vars["--fs-body"]).toBe("14px")
    expect(vars["--fs-h3"]).toBe("13.5px")
    expect(vars["--dur-2"]).toBe("250ms")
    expect(vars["--content-max"]).toBe("1240px")
  })

  it("密度按倍率缩放间距", () => {
    expect(cssVariablesOf({ ...DEFAULT_VALUES, density: "compact" })["--s4"]).toBe("14px")
    expect(cssVariablesOf({ ...DEFAULT_VALUES, density: "comfortable" })["--s5"]).toBe("24px")
  })

  it("字号取到半像素", () => {
    const size = cssVariablesOf({ ...DEFAULT_VALUES, fontScale: "large" })["--fs-hint"] ?? ""
    expect(Number(size.replace("px", "")) * 2 % 1).toBe(0)
  })

  it("关闭动效时各档时长压到 1ms", () => {
    const vars = cssVariablesOf({ ...DEFAULT_VALUES, motion: "off" })
    expect([1, 2, 3, 4].map(i => vars[`--dur-${i}`])).toEqual(["1ms", "1ms", "1ms", "1ms"])
  })

  it("全宽档不设上限", () => {
    expect(cssVariablesOf({ ...DEFAULT_VALUES, width: "full" })["--content-max"]).toBe("none")
  })
})
