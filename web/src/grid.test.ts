import { describe, expect, it } from "vitest"
import {
  COLUMNS,
  applyMove,
  clampSlot,
  compact,
  hideWidget,
  layoutKey,
  normalize,
  overlaps,
  parseBoard,
  rowsOf,
  serializeBoard,
  showWidget,
  visibleOf,
  type Board,
  type Slot,
  type WidgetSpec
} from "./grid.js"

/**
 * 三个组件：两个一行高，一个两行高，恰好占满一行
 *
 * 一律声明 `resizable`：本文件多数断言量的是「尺寸怎么变」，而不可调的组件
 * 其宽高恒等于声明值 —— 那些断言若跑在固定尺寸的夹具上，通过与否与算法无关。
 * 固定尺寸那一路单独一组断言，见「不可调的组件」。
 */
const A: WidgetSpec = { id: "a", w: 4, h: 1, minW: 2, minH: 1, resizable: true }
const SPECS: readonly WidgetSpec[] = [
  A,
  { id: "b", w: 4, h: 1, minW: 2, minH: 1, resizable: true },
  { id: "c", w: 4, h: 2, minW: 2, minH: 1, resizable: true }
]

/** 一个不可调大小的组件，用于钉住「宽高一律取回声明值」 */
const FIXED: WidgetSpec = { id: "f", w: 3, h: 2, minW: 1, minH: 1 }

/** 默认布局：三块并成一行 */
const DEFAULT: Board = normalize({ slots: [], hidden: [] }, SPECS)

/**
 * 按标识排序，便于比对与顺序无关的两份布局
 * @param slots 位置
 * @returns 排好序的副本
 */
function byId(slots: readonly Slot[]): Slot[] {
  return [...slots].sort((x, y) => x.id.localeCompare(y.id))
}

describe("夹紧与重叠", () => {
  it("宽度不足下限时提到下限", () => {
    expect(clampSlot({ id: "a", x: 0, y: 0, w: 1, h: 1 }, A)).toEqual({ id: "a", x: 0, y: 0, w: 2, h: 1 })
  })

  it("**出界时左移而不是裁窄** —— 裁窄会把使用者刚调好的宽度改掉", () => {
    expect(clampSlot({ id: "a", x: 11, y: 0, w: 6, h: 1 }, A)).toEqual({ id: "a", x: 6, y: 0, w: 6, h: 1 })
  })

  it("宽度超过列数时收到列数", () => {
    expect(clampSlot({ id: "a", x: 0, y: 0, w: 99, h: 1 }, A).w).toBe(COLUMNS)
  })

  it("非整数与负数退回默认与 0", () => {
    const bad = { id: "a", x: -3, y: -1, w: 2.5, h: Number.NaN } as unknown as Slot
    expect(clampSlot(bad, A)).toEqual({ id: "a", x: 0, y: 0, w: 4, h: 1 })
  })

  it("**边相接不算重叠** —— 否则同一行里两块永远排不到一起", () => {
    expect(overlaps({ id: "a", x: 0, y: 0, w: 3, h: 1 }, { id: "b", x: 3, y: 0, w: 3, h: 1 })).toBe(false)
    expect(overlaps({ id: "a", x: 0, y: 0, w: 3, h: 1 }, { id: "b", x: 0, y: 1, w: 3, h: 1 })).toBe(false)
  })

  it("压住一角即算重叠", () => {
    expect(overlaps({ id: "a", x: 0, y: 0, w: 3, h: 2 }, { id: "b", x: 2, y: 1, w: 3, h: 2 })).toBe(true)
  })

  it("rowsOf 取最下沿", () => {
    expect(rowsOf([{ id: "a", x: 0, y: 0, w: 2, h: 1 }, { id: "b", x: 0, y: 3, w: 2, h: 2 }])).toBe(5)
    expect(rowsOf([])).toBe(0)
  })
})

describe("不可调的组件", () => {
  /*
   * 这一组钉的是 `clampSlot` 而非把手
   *
   * 只在 `GridBoard.vue` 里不渲染 `.wsize` 挡不住三条路：一份在组件改成固定尺寸之前
   * 存下的旧布局、Shift + 方向键、手改 localStorage。第一条是升级面板后必然发生的事，
   * 而它的表现是「这一格还是原来那个奇怪的大小」—— 没有报错，只有版面不对。
   */
  it("落盘里存着别的尺寸时取回声明值，不认落盘的数", () => {
    expect(clampSlot({ id: "f", x: 0, y: 0, w: 8, h: 5 }, FIXED)).toEqual({ id: "f", x: 0, y: 0, w: 3, h: 2 })
  })

  it("**比声明值小也照样取回** —— 缩过一次的旧布局同样要复位", () => {
    expect(clampSlot({ id: "f", x: 0, y: 0, w: 1, h: 1 }, FIXED)).toEqual({ id: "f", x: 0, y: 0, w: 3, h: 2 })
  })

  it("位置仍然可改：不可调说的是大小，不是不能搬", () => {
    expect(clampSlot({ id: "f", x: 5, y: 2, w: 3, h: 2 }, FIXED)).toEqual({ id: "f", x: 5, y: 2, w: 3, h: 2 })
  })

  it("声明值本身超过列数时仍收到列数 —— 否则一格就把整行挤出界", () => {
    expect(clampSlot({ id: "f", x: 0, y: 0, w: 3, h: 2 }, { ...FIXED, w: 99 }).w).toBe(COLUMNS)
  })

  it("经 applyMove 改尺寸也改不动 —— Shift + 方向键走的正是这条路", () => {
    const specs = [FIXED]
    const board = normalize({ slots: [], hidden: [] }, specs)
    const next = applyMove(board, specs, { id: "f", x: 0, y: 0, w: 6, h: 4 })
    expect(next.slots.find(slot => slot.id === "f")).toEqual({ id: "f", x: 0, y: 0, w: 3, h: 2 })
  })

  it("可调的组件不受影响，落盘的尺寸照旧生效", () => {
    expect(clampSlot({ id: "a", x: 0, y: 0, w: 8, h: 3 }, A)).toEqual({ id: "a", x: 0, y: 0, w: 8, h: 3 })
  })
})

describe("收拢", () => {
  it("**向上收拢**：孤零零摆在第五行的组件落回第一行", () => {
    expect(compact([{ id: "a", x: 2, y: 5, w: 4, h: 1 }])).toEqual([{ id: "a", x: 2, y: 0, w: 4, h: 1 }])
  })

  it("**横向的留白留得住**：同一行右侧空着的列不会被填", () => {
    const slots: Slot[] = [
      { id: "a", x: 0, y: 0, w: 4, h: 1 },
      { id: "b", x: 8, y: 0, w: 4, h: 1 }
    ]
    expect(compact(slots)).toEqual(slots)
  })

  it("重叠者下移，且只移到不再重叠为止", () => {
    const slots: Slot[] = [
      { id: "a", x: 0, y: 0, w: 6, h: 1 },
      { id: "b", x: 0, y: 0, w: 6, h: 1 }
    ]
    expect(compact(slots)).toEqual([
      { id: "a", x: 0, y: 0, w: 6, h: 1 },
      { id: "b", x: 0, y: 1, w: 6, h: 1 }
    ])
  })

  it("**keep 优先占位** —— 否则拖过去的组件会被原住者挤走，表现为「弹回来」", () => {
    const slots: Slot[] = [
      { id: "a", x: 0, y: 0, w: 6, h: 1 },
      { id: "b", x: 0, y: 0, w: 6, h: 1 }
    ]
    expect(compact(slots, "b")).toEqual([
      { id: "b", x: 0, y: 0, w: 6, h: 1 },
      { id: "a", x: 0, y: 1, w: 6, h: 1 }
    ])
  })

  it("**keep 自己不向上收拢** —— 否则任何往下的拖动都会径直弹回第一行", () => {
    const slots: Slot[] = [
      { id: "a", x: 0, y: 3, w: 6, h: 1 },
      { id: "b", x: 6, y: 0, w: 6, h: 1 }
    ]
    expect(compact(slots, "a")).toEqual([
      { id: "b", x: 6, y: 0, w: 6, h: 1 },
      { id: "a", x: 0, y: 3, w: 6, h: 1 }
    ])
    // 同一份位置，不指定 keep 时它收回第一行
    expect(compact(slots).find(slot => slot.id === "a")?.y).toBe(0)
  })
})

describe("补齐与可见", () => {
  it("无落盘布局时按注册顺序逐个补在第一个空位上", () => {
    expect(DEFAULT.slots).toEqual([
      { id: "a", x: 0, y: 0, w: 4, h: 1 },
      { id: "b", x: 4, y: 0, w: 4, h: 1 },
      { id: "c", x: 8, y: 0, w: 4, h: 2 }
    ])
    expect(DEFAULT.hidden).toEqual([])
  })

  it("**已不在注册表内的位置原样留存** —— 插件卸掉再装回，它的组件仍在原处", () => {
    const stale: Slot = { id: "plugin.gone", x: 3, y: 9, w: 5, h: 3 }
    const board = normalize({ slots: [stale], hidden: [] }, SPECS)
    expect(board.slots).toContainEqual(stale)
    expect(visibleOf(board, SPECS).map(slot => slot.id)).toEqual(["a", "b", "c"])
  })

  it("已移除的组件保留位置但不出现在可见之列，其空位可被别人占用", () => {
    const board = normalize({ slots: [{ id: "b", x: 4, y: 0, w: 4, h: 1 }], hidden: ["b"] }, SPECS)
    expect(board.slots).toContainEqual({ id: "b", x: 4, y: 0, w: 4, h: 1 })
    expect(visibleOf(board, SPECS)).toEqual([
      { id: "a", x: 0, y: 0, w: 4, h: 1 },
      { id: "c", x: 4, y: 0, w: 4, h: 2 }
    ])
  })

  it("落盘的位置按下限夹紧", () => {
    const board = normalize({ slots: [{ id: "a", x: 0, y: 0, w: 1, h: 1 }], hidden: [] }, SPECS)
    expect(board.slots.find(slot => slot.id === "a")?.w).toBe(2)
  })

  it("**可见的顺序是先上后左** —— 这同时是窄屏单列的顺序", () => {
    const board: Board = {
      slots: [
        { id: "c", x: 6, y: 1, w: 4, h: 1 },
        { id: "a", x: 6, y: 0, w: 4, h: 1 },
        { id: "b", x: 0, y: 0, w: 4, h: 1 }
      ],
      hidden: []
    }
    expect(visibleOf(board, SPECS).map(slot => slot.id)).toEqual(["b", "a", "c"])
  })
})

describe("落位、移除与添加", () => {
  it("落到别人身上时对方让开，自己留在落点", () => {
    const board = applyMove(DEFAULT, SPECS, { id: "a", x: 4, y: 0, w: 4, h: 1 })
    expect(visibleOf(board, SPECS)).toEqual([
      { id: "a", x: 4, y: 0, w: 4, h: 1 },
      { id: "c", x: 8, y: 0, w: 4, h: 2 },
      { id: "b", x: 4, y: 1, w: 4, h: 1 }
    ])
  })

  it("未登记的标识原样返回，不凭空造出一个位置", () => {
    expect(applyMove(DEFAULT, SPECS, { id: "nope", x: 0, y: 0, w: 2, h: 2 })).toBe(DEFAULT)
  })

  it("移除后其余补位，且**位置留着**，添加回来仍在原处", () => {
    const gone = hideWidget(DEFAULT, SPECS, "b")
    expect(gone.hidden).toEqual(["b"])
    expect(visibleOf(gone, SPECS).map(slot => slot.id)).toEqual(["a", "c"])
    const back = showWidget(gone, SPECS, "b")
    expect(back.hidden).toEqual([])
    expect(byId(visibleOf(back, SPECS))).toEqual(byId(DEFAULT.slots))
  })

  it("重复移除与移除不存在的组件都是空操作", () => {
    const gone = hideWidget(DEFAULT, SPECS, "b")
    expect(hideWidget(gone, SPECS, "b")).toBe(gone)
    expect(showWidget(DEFAULT, SPECS, "b")).toBe(DEFAULT)
  })
})

/*
 * 默认不上板
 *
 * 为显卡而设：多数机器上 nvidia-smi 并不存在，默认摆上去等于默认给多数人一格
 * 永远测不到的东西。这几条钉的是「不上板」与「添加之后要真的上板」两件事 ——
 * 后者曾经不成立：`showWidget` 把「只在 hidden 里、没有位置」的标识交给
 * `normalize` 补位，而 `normalize` 见到 defaultHidden 会当即把它记回 hidden，
 * 于是「添加」这个动作在页面上什么也不发生。
 */
describe("默认不上板的组件", () => {
  /** 四个组件，末一个声明默认不上板 */
  const WITH_GPU: readonly WidgetSpec[] = [...SPECS, { id: "g", w: 6, h: 2, minW: 3, minH: 2, defaultHidden: true }]

  it("初次出现时记入 hidden，不占板上的位置", () => {
    const board = normalize({ slots: [], hidden: [] }, WITH_GPU)
    expect(board.hidden).toEqual(["g"])
    expect(visibleOf(board, WITH_GPU).map(slot => slot.id)).toEqual(["a", "b", "c"])
    expect(board.slots.some(slot => slot.id === "g")).toBe(false)
  })

  it("**添加之后要真的上板** —— 否则「添加」这个动作在页面上什么也不发生", () => {
    const fresh = normalize({ slots: [], hidden: [] }, WITH_GPU)
    const added = showWidget(fresh, WITH_GPU, "g")
    expect(added.hidden).toEqual([])
    expect(visibleOf(added, WITH_GPU).map(slot => slot.id)).toContain("g")
  })

  it("添加后按自己的默认尺寸落位，且不压住原有组件", () => {
    const added = showWidget(normalize({ slots: [], hidden: [] }, WITH_GPU), WITH_GPU, "g")
    const gpu = visibleOf(added, WITH_GPU).find(slot => slot.id === "g")
    expect(gpu?.w).toBe(6)
    expect(gpu?.h).toBe(2)
    // 首行已被 a/b/c 占满 12 列，故它落在其下
    expect(gpu?.y).toBeGreaterThan(0)
  })

  it("**已在板上的不会被重新藏起** —— 只有初次出现才按默认处理", () => {
    const placed: Board = { slots: [{ id: "g", x: 0, y: 3, w: 6, h: 2 }], hidden: [] }
    const board = normalize(placed, WITH_GPU)
    expect(board.hidden).toEqual([])
    expect(visibleOf(board, WITH_GPU).map(slot => slot.id)).toContain("g")
  })

  it("使用者移除之后仍是移除状态，不会每次进页面又冒出来", () => {
    const added = showWidget(normalize({ slots: [], hidden: [] }, WITH_GPU), WITH_GPU, "g")
    const gone = hideWidget(added, WITH_GPU, "g")
    expect(normalize(gone, WITH_GPU).hidden).toEqual(["g"])
  })
})

describe("落盘", () => {
  it("键按页分开", () => {
    expect(layoutKey("overview")).toBe("yunzai-ng.layout.overview")
  })

  it("未存过、坏 JSON、版本不认，三种都退回默认布局", () => {
    expect(parseBoard(null, SPECS)).toEqual(DEFAULT)
    expect(parseBoard("{既不是 JSON", SPECS)).toEqual(DEFAULT)
    expect(parseBoard(JSON.stringify({ v: 99, slots: [{ id: "a", x: 8, y: 3, w: 4, h: 1 }] }), SPECS)).toEqual(DEFAULT)
  })

  it("同一标识出现两次时只认第一条", () => {
    const raw = JSON.stringify({
      v: 1,
      slots: [
        { id: "a", x: 0, y: 0, w: 4, h: 1 },
        { id: "a", x: 8, y: 3, w: 4, h: 1 }
      ]
    })
    expect(parseBoard(raw, SPECS).slots.filter(slot => slot.id === "a")).toHaveLength(1)
  })

  it("缺字段与非整数的条目按默认补齐，不整份丢弃", () => {
    const raw = JSON.stringify({ v: 1, slots: [{ id: "a", x: "左", y: null }] })
    expect(parseBoard(raw, SPECS).slots.find(slot => slot.id === "a")).toEqual({ id: "a", x: 0, y: 0, w: 2, h: 1 })
  })

  it("序列化再解析得回同一份布局，含已移除与未登记的条目", () => {
    const stale: Slot = { id: "plugin.gone", x: 3, y: 9, w: 5, h: 3 }
    const board = hideWidget({ ...DEFAULT, slots: [...DEFAULT.slots, stale] }, SPECS, "b")
    const again = parseBoard(serializeBoard(board), SPECS)
    expect(byId(again.slots)).toEqual(byId(board.slots))
    expect(again.hidden).toEqual(board.hidden)
  })
})
