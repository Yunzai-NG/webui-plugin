/**
 * 模块职责：面板插件形状校验的用例
 * 依赖方向：测试文件，依赖 panelcheck.ts
 * 生命周期：一次性
 * 注意事项：**重点在「不报错的错」那几条**：`page` 写成一个不存在的页面、`defaultLayout.w`
 *          给了小数。这两样都不会抛任何异常 —— 前者让组件在每一页都不出现，后者让这一格
 *          与相邻格错开半格。若只测「缺 id」一类明显的情形，这两条写错了也不会有人知道。
 *
 *          `parseManifest` 的用例同理：它面对的不是自己那半 node 侧的正常响应，
 *          而是反向代理返回的 HTML 错误页一类东西 —— 那时它必须给空数组而不是抛错。
 */
import { describe, expect, it } from "vitest"
import {
  checkConfigPlace,
  checkPanelTabs,
  checkPanelWidget,
  checkPanelWidgets,
  checkStylePlace,
  entryLabel,
  ownerFromRepo,
  packageKeyOf,
  parseManifest,
  pickMeta,
  placeholderId,
  resolvePanelMeta,
  type PanelEntry
} from "./panelcheck.js"

/** 校验用的可选页面，取自 router.ts 的 ROUTES */
const PAGES = ["overview", "accounts", "logs", "plugins", "market", "config", "help"]

/**
 * 造一个形状齐备的插件模块
 * @param patch 覆盖默认导出里的某几项
 * @returns 模块对象
 */
function goodMod(patch: Record<string, unknown> = {}): unknown {
  return {
    default: {
      id: "demo.card",
      page: "overview",
      title: "示例",
      defaultLayout: { w: 3, h: 3, minW: 2, minH: 2 },
      setup: () => () => null,
      ...patch
    }
  }
}

describe("checkPanelWidget", () => {
  it("形状齐备时通过，并把定义原样带出", () => {
    const result = checkPanelWidget(goodMod(), PAGES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.widget.id).toBe("demo.card")
    expect(result.widget.defaultLayout.minW).toBe(2)
  })

  it("minW / minH 可以不给：注册表会替它们取 1", () => {
    expect(checkPanelWidget(goodMod({ defaultLayout: { w: 2, h: 1 } }), PAGES).ok).toBe(true)
  })

  it("**声明 resizable 却缺 minW 时不通过** —— 那一格能被拖成 1×1 的一团字，且不报任何错", () => {
    const result = checkPanelWidget(goodMod({ defaultLayout: { w: 3, h: 3, minH: 2, resizable: true } }), PAGES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 占位格上要写明该补什么：使用者看到「缺少 minW」尚可自行补上，看到「加载失败」只能来问
    expect(result.reason).toContain("minW")
  })

  it("声明 resizable 却缺 minH 时同样不通过", () => {
    expect(
      checkPanelWidget(goodMod({ defaultLayout: { w: 3, h: 3, minW: 2, resizable: true } }), PAGES).ok
    ).toBe(false)
  })

  it("resizable 与两个下限齐备时通过，且 resizable 原样带出", () => {
    const result = checkPanelWidget(
      goodMod({ defaultLayout: { w: 3, h: 3, minW: 2, minH: 2, resizable: true } }),
      PAGES
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.widget.defaultLayout.resizable).toBe(true)
  })

  it("**给了下限却不声明 resizable 不算错** —— 下限另有一用：clampSlot 拿它挡落盘里的坏值", () => {
    expect(checkPanelWidget(goodMod({ defaultLayout: { w: 3, h: 3, minW: 2, minH: 2 } }), PAGES).ok).toBe(true)
  })

  it("resizable 不是布尔时不通过", () => {
    expect(
      checkPanelWidget(goodMod({ defaultLayout: { w: 3, h: 3, minW: 2, minH: 2, resizable: "yes" } }), PAGES).ok
    ).toBe(false)
  })

  it("defaultHidden 给 true 也通过", () => {
    expect(checkPanelWidget(goodMod({ defaultHidden: true }), PAGES).ok).toBe(true)
  })

  it("page 取一个不存在的页面时不通过 —— 这条不报错，只会让组件在每一页都不出现", () => {
    const result = checkPanelWidget(goodMod({ page: "dashboard" }), PAGES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 原因里须带上可选值：使用者写错时最需要知道的是「那到底该写什么」
    expect(result.reason).toContain("dashboard")
    expect(result.reason).toContain("overview")
  })

  it("w 给小数时不通过 —— 栅格全程按整数算，给 2.5 只会让这一格错开半格", () => {
    const result = checkPanelWidget(goodMod({ defaultLayout: { w: 2.5, h: 3 } }), PAGES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("w")
  })

  it("w 给 0 或负数时不通过", () => {
    expect(checkPanelWidget(goodMod({ defaultLayout: { w: 0, h: 3 } }), PAGES).ok).toBe(false)
    expect(checkPanelWidget(goodMod({ defaultLayout: { w: -1, h: 3 } }), PAGES).ok).toBe(false)
  })

  it("minW 给小数时不通过", () => {
    expect(checkPanelWidget(goodMod({ defaultLayout: { w: 3, h: 3, minW: 1.5 } }), PAGES).ok).toBe(
      false
    )
  })

  it("defaultHidden 给字符串时不通过", () => {
    const result = checkPanelWidget(goodMod({ defaultHidden: "yes" }), PAGES)
    expect(result.ok).toBe(false)
  })

  it("没有默认导出时给出「须 export default」", () => {
    const result = checkPanelWidget({ widget: { id: "x" } }, PAGES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("export default")
  })

  it("缺 id / title / page / defaultLayout / setup 时各自不通过", () => {
    for (const key of ["id", "title", "page", "defaultLayout", "setup"]) {
      const result = checkPanelWidget(goodMod({ [key]: undefined }), PAGES)
      expect(result.ok, `缺 ${key} 时应不通过`).toBe(false)
      if (result.ok) continue
      expect(result.reason, `缺 ${key} 的原因里应提到它`).toContain(key)
    }
  })

  it("id 给空串或纯空白时不通过 —— 空标识会让落盘的布局认不出这一格", () => {
    expect(checkPanelWidget(goodMod({ id: "" }), PAGES).ok).toBe(false)
    expect(checkPanelWidget(goodMod({ id: "   " }), PAGES).ok).toBe(false)
  })

  it("setup 不是函数时不通过", () => {
    const result = checkPanelWidget(goodMod({ setup: "() => {}" }), PAGES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("setup")
  })

  it("模块本身不是对象时不通过，不抛错", () => {
    expect(checkPanelWidget(undefined, PAGES).ok).toBe(false)
    expect(checkPanelWidget("export default", PAGES).ok).toBe(false)
    expect(checkPanelWidget(null, PAGES).ok).toBe(false)
  })

  it("默认导出是数组时不通过 —— 数组也是 object，须单独排掉", () => {
    expect(checkPanelWidget({ default: [] }, PAGES).ok).toBe(false)
  })
})

describe("checkPanelWidgets", () => {
  /**
   * 造一枚合格的组件定义
   * @param patch 覆盖某几项
   * @returns 定义对象
   */
  function widget(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "demo.card",
      page: "overview",
      title: "示例",
      defaultLayout: { w: 3, h: 3 },
      setup: () => () => null,
      ...patch
    }
  }

  it("单个默认导出照旧通过，结果是长度 1 的数组", () => {
    const result = checkPanelWidgets(goodMod(), PAGES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.widgets.map(w => w.id)).toEqual(["demo.card"])
    expect(result.skipped).toEqual([])
  })

  it("**默认导出可以是数组** —— 一个插件一口气给出十来枚组件时不必拆成十个包", () => {
    const mod = { default: [widget({ id: "a" }), widget({ id: "b" }), widget({ id: "c" })] }
    const result = checkPanelWidgets(mod, PAGES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.widgets.map(w => w.id)).toEqual(["a", "b", "c"])
  })

  it("一枚写错不连坐其余，被丢掉的那枚各留一句原因且指明是第几枚", () => {
    const mod = { default: [widget({ id: "a" }), widget({ id: "bad", page: "nowhere" }), widget({ id: "c" })] }
    const result = checkPanelWidgets(mod, PAGES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.widgets.map(w => w.id)).toEqual(["a", "c"])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain("第 2 个组件")
    expect(result.skipped[0]).toContain("nowhere")
  })

  it("一枚都不合格才算整体失败，原因里含每一枚的说法", () => {
    const mod = { default: [widget({ id: undefined }), widget({ page: "nowhere" })] }
    const result = checkPanelWidgets(mod, PAGES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("第 1 个组件")
    expect(result.reason).toContain("第 2 个组件")
  })

  it("空数组算失败：那多半是筛选条件写错了，而静默通过后一个组件都不会出现", () => {
    const result = checkPanelWidgets({ default: [] }, PAGES)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("空数组")
  })
})

describe("parseManifest", () => {
  it("取出形状齐备的项", () => {
    const items = parseManifest({
      items: [
        { owner: "local", file: "a.js", url: "/plugin/webui/pp/local/a.js" },
        { owner: "hardware", file: "hardware.js", url: "/plugin/webui/pp/hardware/hardware.js" }
      ]
    })
    expect(items).toHaveLength(2)
    expect(items[1]?.owner).toBe("hardware")
  })

  it("响应不是对象、或没有 items 时给空数组而不抛错", () => {
    // 最常见者为反向代理返回的 HTML 错误页：那时「没有面板插件」是对的结论，
    // 而抛错会让整段加载中断，连好的那些插件也一并不出现
    expect(parseManifest("<html>502</html>")).toEqual([])
    expect(parseManifest(undefined)).toEqual([])
    expect(parseManifest({})).toEqual([])
    expect(parseManifest({ items: "none" })).toEqual([])
  })

  it("滤掉缺字段的项，保留其余", () => {
    const items = parseManifest({
      items: [
        { owner: "local", file: "a.js" },
        { owner: "local", file: "b.js", url: "/plugin/webui/pp/local/b.js" },
        "c.js"
      ]
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.file).toBe("b.js")
  })
})

describe("ownerFromRepo", () => {
  it("从 https 地址取归属名", () => {
    expect(ownerFromRepo("git+https://github.com/Yunzai-NG/hardware-plugin.git")).toBe("Yunzai-NG")
  })

  it("从 SSH 写法取归属名 —— 冒号后面也是「归属/仓库」两段", () => {
    expect(ownerFromRepo("git@github.com:Yunzai-NG/x.git")).toBe("Yunzai-NG")
  })

  it("不足两段时推不出", () => {
    expect(ownerFromRepo("local")).toBeUndefined()
  })
})

describe("pickMeta", () => {
  /** 四项齐备的一份自报信息 */
  const full = { version: "1.0.0", description: "一句话", repository: "https://example.com/a", author: "某人" }

  it("四项齐备时取出，且各项去掉首尾空白", () => {
    expect(pickMeta({ ...full, author: "  某人  " })).toEqual(full)
  })

  it.each(["version", "description", "repository"])("缺 %s 即整份作废", key => {
    const rest = Object.fromEntries(Object.entries(full).filter(([k]) => k !== key))
    expect(pickMeta(rest)).toBeUndefined()
  })

  /*
   * 这一条钉住的是「规则罚了正确的用法」
   *
   * 初版把 author 也列作必需，而本项目自己的五个插件一个都没写它 —— npm 里 author 本就是
   * 常缺的可选字段。拿它当门槛的后果是 hardware 那三枚示例组件变成三格红字，而它们
   * 并没写错什么。仓库地址已指明出处，归属名即是可显示的作者。
   */
  it("缺 author 时从仓库地址推归属名，不作废", () => {
    const { author: _drop, ...rest } = full
    expect(pickMeta({ ...rest, repository: "git+https://github.com/Yunzai-NG/x.git" })).toEqual({
      version: "1.0.0",
      description: "一句话",
      repository: "git+https://github.com/Yunzai-NG/x.git",
      author: "Yunzai-NG"
    })
  })

  it("author 为空白且仓库地址推不出时才作废 —— 那时确实无从知道这是谁的", () => {
    expect(pickMeta({ ...full, author: "   ", repository: "local" })).toBeUndefined()
  })

  it("不是对象时给 undefined，不抛错", () => {
    expect(pickMeta(undefined)).toBeUndefined()
    expect(pickMeta(null)).toBeUndefined()
    expect(pickMeta("1.0.0")).toBeUndefined()
  })
})

describe("resolvePanelMeta", () => {
  /** 四项齐备的一份自报信息 */
  const full = { version: "1.0.0", description: "一句话", repository: "https://example.com/a", author: "某人" }

  /**
   * 造一个清单项
   * @param patch 覆盖其中某几项
   * @returns 清单项
   */
  const entryOf = (patch: Record<string, unknown> = {}): PanelEntry => ({
    owner: "panels",
    file: "clock.js",
    url: "/plugin/webui/pp/panels/clock.js",
    kind: "single",
    ...patch
  })

  it("单文件从模块的 meta 导出取", () => {
    const r = resolvePanelMeta({ meta: full }, entryOf())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.meta).toEqual(full)
  })

  it("单文件缺 meta 导出时不通过，且原因写明该写什么", () => {
    const r = resolvePanelMeta({ default: {} }, entryOf())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("export const meta")
  })

  /*
   * 这一条查的是「两轴合用一个字段」那个不报错的错
   *
   * 插件带的 `panel/*.js` 是**单文件形态**（商店若要装它是 raw 下载一个 js），
   * 却由 node 侧从插件自己的 package.json 填好了 meta。若按 `kind` 分派取值来源，
   * 这一路会被要求在 js 里再写一遍 meta —— 而 hardware-plugin 的三个组件都没写，
   * 表现是三格红字占位，且原因指向一份它们根本不该改的文件。
   */
  it("单文件形态但 node 侧已读到时，用那一份，不再要求模块导出", () => {
    const r = resolvePanelMeta({ default: {} }, entryOf({ owner: "hardware", meta: full }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.meta).toEqual(full)
  })

  it("node 侧那份缺字段时退回模块导出 —— 半份不算数", () => {
    const r = resolvePanelMeta({ meta: full }, entryOf({ meta: { version: "1.0.0" } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.meta).toEqual(full)
  })

  it("多文件缺 package.json 字段时，原因指向 package.json 而非 js", () => {
    const r = resolvePanelMeta({ meta: full }, entryOf({ file: "weather/index.js", kind: "multi" }))
    expect(r.ok).toBe(false)
    // 多文件的 meta 只认 package.json：模块里写了也不采，否则两处早晚不一致
    if (!r.ok) {
      expect(r.reason).toContain("package.json")
      expect(r.reason).toContain("weather/index.js")
    }
  })

  it("kind 缺省当单文件，故旧清单仍可用", () => {
    const { kind: _drop, ...rest } = entryOf()
    const r = resolvePanelMeta({ meta: full }, rest)
    expect(r.ok).toBe(true)
  })
})

describe("entryLabel / placeholderId", () => {
  const entry = { owner: "local", file: "hardware.js", url: "/plugin/webui/pp/local/hardware.js" }

  it("称呼带上归属，使用者据此知道该去哪个目录找那个文件", () => {
    expect(entryLabel(entry)).toBe("local/hardware.js")
  })

  it("占位格的 id 带上归属：两路下的同名文件不能撞成同一个 id", () => {
    const other = { owner: "hardware", file: "hardware.js", url: "/x" }
    expect(placeholderId(entry)).not.toBe(placeholderId(other))
    expect(placeholderId(entry)).toBe("panelfail.local.hardware.js")
  })
})

/*
 * 包键：插件页「一个包一张卡片」的归并依据
 *
 * **这一条算错了不报错**，只表现为「一个装了九枚组件的包在插件页上摊成九张卡片」，
 * 或者反过来「两个互不相干的单文件被并成一张」。故两种形态各钉一条。
 */
describe("packageKeyOf", () => {
  it("多文件取目录名，故同一个包的各枚组件归成同一个键", () => {
    expect(packageKeyOf({ owner: "panels", file: "hardware/index.js", url: "/x" })).toBe("panels/hardware")
  })

  it("单文件取文件名本身 —— 单文件也算一个包，否则插件页要分两种列法", () => {
    expect(packageKeyOf({ owner: "panels", file: "clock.js", url: "/x" })).toBe("panels/clock.js")
  })

  it("**两个单文件不会被并成同一个包**", () => {
    const a = packageKeyOf({ owner: "panels", file: "clock.js", url: "/x" })
    const b = packageKeyOf({ owner: "panels", file: "nometa.js", url: "/x" })
    expect(a).not.toBe(b)
  })

  it("与 node 侧判「这个包的 node 侧跑起来了吗」用的是同一条规则", () => {
    // src/index.ts 里那一句：`${entry.owner}/${entry.file.split("/")[0]}`
    const entry = { owner: "panels", file: "hardware/index.js", url: "/x" }
    expect(packageKeyOf(entry)).toBe(`${entry.owner}/${entry.file.split("/")[0]}`)
  })
})

describe("checkPanelTabs", () => {
  /** 一个形状齐备的页签 */
  const goodTab = { id: "hardware.detail", title: "硬件详情", setup: () => () => null }

  it("**没有 tabs 导出不是错** —— 绝大多数包只出组件，报错会让每个既有插件都多一句错话", () => {
    expect(checkPanelTabs({ default: {} })).toEqual({ tabs: [], skipped: [] })
    expect(checkPanelTabs({})).toEqual({ tabs: [], skipped: [] })
    expect(checkPanelTabs(undefined)).toEqual({ tabs: [], skipped: [] })
  })

  it("给一个数组时逐个收下", () => {
    const r = checkPanelTabs({ tabs: [goodTab, { ...goodTab, id: "hardware.bench", title: "跑分" }] })
    expect(r.tabs.map(t => t.id)).toEqual(["hardware.detail", "hardware.bench"])
    expect(r.skipped).toEqual([])
  })

  it("给单个对象（不是数组）也认", () => {
    expect(checkPanelTabs({ tabs: goodTab }).tabs).toHaveLength(1)
  })

  it("缺 id 时不收，且原因写明缺什么", () => {
    const { id: _drop, ...noId } = goodTab
    const r = checkPanelTabs({ tabs: [noId] })
    expect(r.tabs).toHaveLength(0)
    expect(r.skipped[0]).toContain("id")
  })

  it("缺 title 时不收", () => {
    const { title: _drop, ...noTitle } = goodTab
    expect(checkPanelTabs({ tabs: [noTitle] }).tabs).toHaveLength(0)
  })

  it("setup 不是函数时不收 —— 它须返回一个渲染函数", () => {
    const r = checkPanelTabs({ tabs: [{ ...goodTab, setup: "nope" }] })
    expect(r.tabs).toHaveLength(0)
    expect(r.skipped[0]).toContain("setup")
  })

  it("**部分合格的照收，与组件同一取舍** —— 三个里错一个不连坐另外两个", () => {
    const r = checkPanelTabs({
      tabs: [goodTab, { id: "x" }, { ...goodTab, id: "hardware.bench", title: "跑分" }]
    })
    expect(r.tabs.map(t => t.id)).toEqual(["hardware.detail", "hardware.bench"])
    expect(r.skipped).toHaveLength(1)
    // 原因里带上位次：一个包出三个页签时，「缺 title」不说清是哪一个便无从下手
    expect(r.skipped[0]).toContain("第 2 个")
  })

  it("空数组给出空结果而非一句错 —— 写了 `tabs: []` 与没写是同一个意思", () => {
    expect(checkPanelTabs({ tabs: [] })).toEqual({ tabs: [], skipped: [] })
  })
})

describe("checkConfigPlace", () => {
  /** 一个多文件包的清单项 */
  const multi: PanelEntry = {
    owner: "panels",
    file: "hardware/index.js",
    url: "/plugin/webui/pp/panels/hardware/index.js",
    kind: "multi"
  }

  /** 一份最简声明 */
  const schema = { type: "object" as const, properties: { host: { type: "string" as const } } }

  it("两处都没写：什么都不说 —— 绝大多数包不需要配置", () => {
    expect(checkConfigPlace({ default: [] }, multi)).toBeUndefined()
    expect(checkConfigPlace({ default: {} }, { ...multi, kind: "single", file: "clock.js" })).toBeUndefined()
  })

  it("只写在 package.json 里：正解，不说话", () => {
    expect(checkConfigPlace({ default: [] }, { ...multi, config: { schema, value: {} } })).toBeUndefined()
  })

  it("**包把 schema 写进了 index.js**：指向 package.json，否则作者只看到「配置按钮没出现」", () => {
    const got = checkConfigPlace({ default: [], config: schema }, multi)
    expect(got).toContain("webuiPanel.config")
  })

  it("**单文件写了 config 导出**：说清它没有这个能力，并给出改成包的出路", () => {
    const got = checkConfigPlace({ default: {}, config: schema }, { ...multi, kind: "single", file: "clock.js" })
    expect(got).toContain("单文件面板插件不支持配置项")
    expect(got).toContain("改成一个包")
  })

  it("kind 缺省时按单文件论：旧清单里没有这个字段", () => {
    const { kind: _kind, ...noKind } = multi
    expect(checkConfigPlace({ config: schema }, noKind)).toContain("单文件")
  })

  it("**两处都写了**：说明 js 那份不会被读到 —— 同一件事两个说法迟早不一致", () => {
    const got = checkConfigPlace({ default: [], config: schema }, { ...multi, config: { schema, value: {} } })
    expect(got).toContain("不会被读取")
  })

  it("声明写坏（node 侧已给出 configError）时不再重复一遍：同一件事只该有一句话", () => {
    expect(checkConfigPlace({ default: [], config: schema }, { ...multi, configError: "写坏了" })).toBeUndefined()
  })

  it("模块不是对象时不说话：那是「加载失败」该管的事", () => {
    expect(checkConfigPlace(undefined, multi)).toBeUndefined()
  })
})

describe("checkStylePlace", () => {
  /** 一个多文件包的清单项 */
  const multi: PanelEntry = {
    owner: "panels",
    file: "hardware/index.js",
    url: "/plugin/webui/pp/panels/hardware/index.js",
    kind: "multi"
  }

  /** 那个包的单文件版本 */
  const single: PanelEntry = { ...multi, kind: "single", file: "clock.js" }

  it("没写 style 导出：什么都不说 —— 绝大多数包不自带样式", () => {
    expect(checkStylePlace({ default: [] }, multi)).toBeUndefined()
    expect(checkStylePlace({ default: {} }, single)).toBeUndefined()
  })

  it("只写在 package.json 里：正解，不说话", () => {
    expect(checkStylePlace({ default: [] }, { ...multi, style: "/plugin/webui/pp/panels/hardware/s.css" })).toBeUndefined()
  })

  it("**包把 style 写进了 index.js**：指向 package.json，否则作者只看到「样式没生效」", () => {
    const got = checkStylePlace({ default: [], style: ".a{}" }, multi)
    expect(got).toContain("webuiPanel.style")
  })

  it("**单文件写了 style 导出**：说清它没有这个能力，并给出两条出路", () => {
    const got = checkStylePlace({ default: {}, style: ".a{}" }, single)
    expect(got).toContain("单文件面板插件不支持自带样式表")
    expect(got).toContain("改成一个包")
    expect(got).toContain("行内样式")
  })

  it("kind 缺省时按单文件论：旧清单里没有这个字段", () => {
    const { kind: _kind, ...noKind } = multi
    expect(checkStylePlace({ style: ".a{}" }, noKind)).toContain("单文件")
  })

  it("**两处都写了**：说明 js 那份不会被读到", () => {
    const got = checkStylePlace({ style: ".a{}" }, { ...multi, style: "/plugin/webui/pp/panels/hardware/s.css" })
    expect(got).toContain("不会被读取")
  })

  it("路径写坏（node 侧已给出 styleError）时不再重复一遍：同一件事只该有一句话", () => {
    expect(checkStylePlace({ style: ".a{}" }, { ...multi, styleError: "那个文件不存在" })).toBeUndefined()
  })

  it("模块不是对象时不说话：那是「加载失败」该管的事", () => {
    expect(checkStylePlace(undefined, multi)).toBeUndefined()
  })
})
