import { describe, expect, it } from "vitest"
import {
  CLASSIC_INFO,
  DEFAULT_PREFS,
  DEFAULT_THEME,
  backdropOf,
  cssVariablesOf,
  defaultState,
  effectiveOverrides,
  parseAppearance,
  readAppearance,
  sanitizeOverrides,
  sanitizePrefs,
  type ActiveThemeInfo,
  type AppearanceState
} from "./appearance.js"

/*
 * 只测纯函数
 *
 * `initAppearance` 要 document / localStorage，用例环境是 node。会悄悄算错的是这几处：
 * 落盘数据的校验、旧格式的迁移、主题允许改哪些项、以及「没改过的项不写变量」。
 */

/** 一款不许改强调色、自带点阵背景的主题 */
const BRANDED: ActiveThemeInfo = {
  id: "pumpkin",
  options: { accentHue: false, radius: true, backdrop: true },
  defaultBackdrop: "dots"
}

describe("readAppearance", () => {
  it("没存过、空串、坏 JSON 都取默认", () => {
    expect(readAppearance(null)).toEqual(defaultState())
    expect(readAppearance("")).toEqual(defaultState())
    expect(readAppearance("{oops")).toEqual(defaultState())
  })

  it("新装默认是经典主题", () => {
    expect(readAppearance(null).theme).toBe(DEFAULT_THEME)
    expect(DEFAULT_THEME).toBe("classic")
  })

  it("读回自己写的 v2", () => {
    const state: AppearanceState = {
      theme: "pumpkin",
      prefs: { ...DEFAULT_PREFS, density: "compact", lowPower: true },
      perTheme: { classic: { accentHue: 18 }, pumpkin: { radius: "large" } }
    }
    expect(readAppearance(JSON.stringify({ version: 2, ...state }))).toEqual(state)
  })

  it("v2 里非法的主题 id 退回经典，非法的改动丢掉", () => {
    const got = parseAppearance({ version: 2, theme: "../evil", perTheme: { "a b": { accentHue: 1 }, ok: { radius: "huge" } } })
    expect(got.theme).toBe("classic")
    expect(got.perTheme).toEqual({})
  })
})

describe("从旧版迁移", () => {
  it("旧的色相、圆角、背景归到经典名下，偏好进 prefs", () => {
    const got = parseAppearance({
      values: { accentHue: 18, radius: "large", backdrop: "dots", density: "compact", motion: "off", glassEffect: true }
    })
    expect(got.theme).toBe("classic")
    expect(got.perTheme).toEqual({ classic: { accentHue: 18, radius: "large", backdrop: "dots" } })
    expect(got.prefs).toEqual({ ...DEFAULT_PREFS, density: "compact", motion: "off" })
  })

  it("旧默认值不算改过：老用户迁过来之后，经典照样是经典自己的样子", () => {
    const got = parseAppearance({ values: { accentHue: 239, radius: "medium", backdrop: "gradient" } })
    expect(got.perTheme).toEqual({})
  })

  it("玻璃拟态那一项被丢弃", () => {
    const got = parseAppearance({ values: { glassEffect: true } })
    expect(JSON.stringify(got)).not.toContain("glass")
  })

  it("更早的 { preset, custom } 也认", () => {
    const got = parseAppearance({ preset: "compact", custom: { accentHue: 152 } })
    expect(got.prefs.density).toBe("compact")
    expect(got.perTheme.classic).toEqual({ accentHue: 152, radius: "small" })
  })
})

describe("sanitize", () => {
  it("偏好只认合法档位", () => {
    expect(sanitizePrefs({ density: "huge", width: "wide", lowPower: "yes" })).toEqual({ width: "wide" })
    expect(sanitizePrefs({ lowPower: true })).toEqual({ lowPower: true })
  })

  it("色相夹到 0–360 并取整", () => {
    expect(sanitizeOverrides({ accentHue: 400.6 })).toEqual({ accentHue: 360 })
    expect(sanitizeOverrides({ accentHue: -3 })).toEqual({ accentHue: 0 })
    expect(sanitizeOverrides({ accentHue: "18" })).toEqual({})
  })
})

describe("主题允许改的项", () => {
  const state: AppearanceState = {
    ...defaultState(),
    theme: "pumpkin",
    perTheme: { pumpkin: { accentHue: 200, radius: "small" } }
  }

  it("主题不许改的项即使存着也不生效", () => {
    expect(effectiveOverrides(state, BRANDED)).toEqual({ radius: "small" })
  })

  it("改动按主题分开：经典名下的色相不带进别的主题", () => {
    const s: AppearanceState = { ...defaultState(), theme: "other", perTheme: { classic: { accentHue: 18 } } }
    expect(effectiveOverrides(s, { ...CLASSIC_INFO, id: "other" })).toEqual({})
  })

  it("背景没改过时用主题自己的", () => {
    expect(backdropOf(defaultState(), BRANDED)).toBe("dots")
    expect(backdropOf(defaultState(), CLASSIC_INFO)).toBe("gradient")
  })
})

describe("cssVariablesOf", () => {
  it("没改过的强调色与圆角不写变量，留给主题", () => {
    const vars = cssVariablesOf(defaultState(), CLASSIC_INFO)
    expect(vars["--accent-hue"]).toBeUndefined()
    expect(vars["--r-card"]).toBeUndefined()
  })

  it("改过的才写", () => {
    const s: AppearanceState = { ...defaultState(), perTheme: { classic: { accentHue: 18, radius: "large" } } }
    const vars = cssVariablesOf(s, CLASSIC_INFO)
    expect(vars["--accent-hue"]).toBe("18")
    expect(vars["--r-card"]).toBe("20px")
    expect(vars["--r-ctl"]).toBe("14px")
  })

  it("个人偏好每次都写，且与主题无关", () => {
    const s: AppearanceState = { ...defaultState(), prefs: { ...DEFAULT_PREFS, density: "comfortable", fontScale: "large" } }
    const a = cssVariablesOf(s, CLASSIC_INFO)
    const b = cssVariablesOf({ ...s, theme: "pumpkin" }, BRANDED)
    expect(a["--s4"]).toBe("19px")
    expect(a["--fs-body"]).toBe("15px")
    expect(b["--s4"]).toBe(a["--s4"])
    expect(b["--fs-body"]).toBe(a["--fs-body"])
  })

  it("关闭动效时四档时长都压到 1ms", () => {
    const s: AppearanceState = { ...defaultState(), prefs: { ...DEFAULT_PREFS, motion: "off" } }
    const vars = cssVariablesOf(s, CLASSIC_INFO)
    expect([vars["--dur-1"], vars["--dur-4"]]).toEqual(["1ms", "1ms"])
  })
})
