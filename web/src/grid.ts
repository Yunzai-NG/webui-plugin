/**
 * 模块职责：栅格布局的取值 —— 12 列的位置计算、越界收拢、落盘格式的解析与序列化
 * 依赖方向：无依赖，全为纯函数
 * 生命周期：模块级常量与纯函数
 * 注意事项：**本模块不碰 DOM，也不碰 localStorage**，只提供「字符串 ↔ 布局」两个方向的
 *          纯函数，真正读写那两行在 `GridBoard.vue` 里。用例跑在 node 环境（无 jsdom），
 *          而这套算法算错了不报错、只表现为版面不对 —— 故须与浏览器 API 分开。
 *
 *          **向上收拢（重力）是刻意的**：每次落位后全部组件依「先上后左」向上收到不再
 *          重叠。代价是纵向留白留不住，换来的是「移除一个组件后其余自动补位」。
 *          要留白只能靠横向：同一行右侧空着的列不会被填。
 *
 *          **已移除的组件与已不在注册表内的组件，其位置一并留存**，故插件卸掉再装回、
 *          或移除后再添加，都回到原处。这两份记录只增不减，每条一个标识加四个整数。
 */

/** 栅格列数 */
export const COLUMNS = 12

/** 落盘格式版本；不认识的版本一律退回默认布局，不做迁移 */
const VERSION = 1

/** 一个组件在栅格上的位置 */
export interface Slot {
  /** 组件标识 */
  id: string
  /** 起始列，自 0 计 */
  x: number
  /** 起始行，自 0 计 */
  y: number
  /** 占用列数 */
  w: number
  /** 占用行数 */
  h: number
}

/** 一个组件声明的默认尺寸与下限 */
export interface WidgetSpec {
  /** 组件标识 */
  id: string
  /** 默认列数 */
  w: number
  /** 默认行数 */
  h: number
  /** 最少列数 */
  minW: number
  /** 最少行数 */
  minH: number
  /**
   * 使用者是否可改这一格的大小
   *
   * 缺省为假，即**尺寸固定**：`clampSlot` 一律把宽高夹成声明的 `w` / `h`，于是拖动把手、
   * Shift + 方向键、乃至手改 localStorage 都改不动它。一枚卡片能缩到多小取决于它里头
   * 装的是什么，只有写它的人知道，故由组件明说而非一律放开。
   *
   * 为真时 `minW` / `minH` 必须由组件给出（校验见 `panelcheck.ts`）：声明可调却不给下限
   * 等同于一律放开。
   */
  resizable?: boolean
  /**
   * 是否默认不上板
   *
   * 为真时该组件在**从未有过位置**的情况下记入 `hidden`，于是不占格子，但出现在编辑态的
   * 「已移除」里可随时添加。与「使用者手动移除」共用同一份 `hidden`，故本字段只决定
   * 出厂状态 —— 使用者添加过之后按他的选择办。
   *
   * 为 GPU 而设：多数机器上探不到（AMD、Intel、Termux 一概没有 nvidia-smi）。
   */
  defaultHidden?: boolean
}

/** 一页的布局 */
export interface Board {
  /** 全部已知位置，含已移除与已不在注册表内的组件 */
  slots: Slot[]
  /** 使用者移除的组件标识 */
  hidden: string[]
}

/**
 * 某一页布局在 localStorage 中的键
 * @param page 页面标识
 * @returns 存储键
 */
export function layoutKey(page: string): string {
  return `yunzai-ng.layout.${page}`
}

/**
 * 取整数，非整数一律退回给定值
 * @param value 待取的值
 * @param fallback 退路
 * @returns 整数
 */
function intOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback
}

/**
 * 两个位置是否重叠
 *
 * 边相接不算重叠：`x: 0, w: 3` 与 `x: 3, w: 3` 是相邻的两块，不是压在一起的两块。
 * @param a 一个位置
 * @param b 另一个位置
 * @returns 是否重叠
 */
export function overlaps(a: Slot, b: Slot): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * 把一个位置收进合法范围
 *
 * 先按下限与列数收拢宽度，再据此夹住起始列 —— 反过来做的话，`x: 11, w: 6` 会先被
 * 夹成 `x: 11`，而自第 11 列起再占 6 列仍然出界。
 *
 * **不可调大小的组件，宽高一律取回声明值**，落盘里存的是什么都不算。这一处是该约束
 * 唯一的关口：只做在把手上挡不住旧布局、Shift + 方向键与手改 localStorage 三条路。
 * @param slot 待收拢的位置
 * @param spec 该组件声明的默认与下限
 * @returns 合法的位置
 */
export function clampSlot(slot: Slot, spec: WidgetSpec): Slot {
  const free = spec.resizable === true
  const w = free ? Math.min(COLUMNS, Math.max(spec.minW, intOf(slot.w, spec.w))) : Math.min(COLUMNS, spec.w)
  const h = free ? Math.max(spec.minH, intOf(slot.h, spec.h)) : spec.h
  const x = Math.min(COLUMNS - w, Math.max(0, intOf(slot.x, 0)))
  const y = Math.max(0, intOf(slot.y, 0))
  return { id: slot.id, x, y, w, h }
}

/**
 * 一批位置共占到第几行
 * @param slots 位置
 * @returns 行数；无位置时为 0
 */
export function rowsOf(slots: readonly Slot[]): number {
  return slots.reduce((max, slot) => Math.max(max, slot.y + slot.h), 0)
}

/**
 * 收拢一批位置：先向下让开重叠，再向上收到不能再上
 *
 * 顺序为「`keep` 优先，其余先上后左」。`keep` 是使用者刚落位的那一个，让它先占位、
 * 其余绕开它 —— 反过来的话被拖动的组件会被原先那个挤走，表现为「拖过去又弹回来」。
 *
 * **`keep` 自己不参与向上收拢**，否则任何往下的拖动都会径直弹回第一行。代价是刻意
 * 留出的纵向空带只活到下一次拖动为止。
 * @param slots 待收拢的位置
 * @param keep 优先占位、且不参与收拢的组件标识
 * @returns 收拢后的位置，顺序为先上后左
 */
export function compact(slots: readonly Slot[], keep?: string): Slot[] {
  const order = [...slots].sort((a, b) => {
    if (a.id === keep) return -1
    if (b.id === keep) return 1
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  })
  const placed: Slot[] = []
  for (const slot of order) {
    const moved = { ...slot }
    while (placed.some(other => overlaps(other, moved))) moved.y += 1
    if (slot.id !== keep) {
      while (moved.y > 0 && !placed.some(other => overlaps(other, { ...moved, y: moved.y - 1 }))) moved.y -= 1
    }
    placed.push(moved)
  }
  return [...placed].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x))
}

/**
 * 一个组件初次上板时占多大
 *
 * 与 `clampSlot` 分开：那个收拢的是**已有的**位置（落盘值可能是坏的），这个算的是一个
 * 还没有位置的组件该占多大。`normalize` 与 `showWidget` 共用一份，免得少改一处便有
 * 一条路上的组件以未夹紧的尺寸落板。
 * @param spec 组件声明
 * @returns 列数与行数
 */
function sizeOf(spec: WidgetSpec): { w: number; h: number } {
  return { w: Math.min(Math.max(spec.w, spec.minW), COLUMNS), h: Math.max(spec.h, spec.minH) }
}

/**
 * 找出放得下给定尺寸的第一个空位，先上后左
 * @param placed 已占用的位置
 * @param w 列数
 * @param h 行数
 * @returns 起始列与起始行
 */
function firstFree(placed: readonly Slot[], w: number, h: number): { x: number; y: number } {
  const width = Math.min(w, COLUMNS)
  const limit = rowsOf(placed)
  // 至 limit 行时其下必然全空，故循环必在此之前返回
  for (let y = 0; y <= limit; y += 1) {
    for (let x = 0; x + width <= COLUMNS; x += 1) {
      if (!placed.some(other => overlaps(other, { id: "", x, y, w: width, h }))) return { x, y }
    }
  }
  return { x: 0, y: limit }
}

/**
 * 可见组件的位置，顺序即渲染顺序
 *
 * 该顺序（先上后左）同时是窄屏单列的顺序 —— 窄屏忽略 x/y/w，直接按这个顺序顺排，
 * 因此 DOM 顺序与两种版面下的视觉顺序都一致，Tab 键与读屏器无须另作安排。
 * @param board 布局
 * @param specs 注册表给出的组件
 * @returns 已登记且未被移除的位置
 */
export function visibleOf(board: Board, specs: readonly WidgetSpec[]): Slot[] {
  const known = new Set(specs.map(spec => spec.id))
  const hidden = new Set(board.hidden)
  return board.slots
    .filter(slot => known.has(slot.id) && !hidden.has(slot.id))
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x))
}

/**
 * 把一批算好的位置写回布局，其余条目原样保留
 * @param board 布局
 * @param settled 算好的位置
 * @returns 新布局
 */
function writeBack(board: Board, settled: readonly Slot[]): Board {
  const byId = new Map(settled.map(slot => [slot.id, slot]))
  return { slots: board.slots.map(slot => byId.get(slot.id) ?? slot), hidden: [...board.hidden] }
}

/**
 * 补齐、夹紧并收拢一份布局
 *
 * 三件事：注册表里有而布局里没有的组件按注册顺序补在第一个空位上；已登记的位置按其
 * 下限夹紧；全部可见位置收拢一遍。未登记与已移除的条目原样留存。
 *
 * **声明了 `defaultHidden` 的组件是例外**：它初次出现时记入 `hidden` 而不是补上板，
 * 于是出现在编辑态的「已移除」一栏里等人添加。只对**初次出现**如此 —— 已在
 * `slots` 里的（使用者添加过）照常摆上，理由见 `WidgetSpec.defaultHidden`。
 * @param board 布局
 * @param specs 注册表给出的组件
 * @returns 新布局
 */
export function normalize(board: Board, specs: readonly WidgetSpec[]): Board {
  const known = new Map(specs.map(spec => [spec.id, spec]))
  const hidden = new Set(board.hidden)
  const rest: Slot[] = []
  const visible: Slot[] = []
  for (const slot of board.slots) {
    const spec = known.get(slot.id)
    if (spec === undefined || hidden.has(slot.id)) rest.push({ ...slot })
    else visible.push(clampSlot(slot, spec))
  }
  const seen = new Set(board.slots.map(slot => slot.id))
  const added: string[] = []
  for (const spec of specs) {
    if (seen.has(spec.id) || hidden.has(spec.id)) continue
    if (spec.defaultHidden === true) {
      added.push(spec.id)
      continue
    }
    const { w, h } = sizeOf(spec)
    const at = firstFree(visible, w, h)
    visible.push({ id: spec.id, x: at.x, y: at.y, w, h })
  }
  return { slots: [...compact(visible), ...rest], hidden: [...board.hidden, ...added] }
}

/**
 * 落位一个组件
 * @param board 布局
 * @param specs 注册表给出的组件
 * @param next 该组件的新位置
 * @returns 新布局；该组件未登记时原样返回
 */
export function applyMove(board: Board, specs: readonly WidgetSpec[], next: Slot): Board {
  const spec = specs.find(item => item.id === next.id)
  if (spec === undefined) return board
  const moved = clampSlot(next, spec)
  const visible = visibleOf(board, specs).map(slot => (slot.id === moved.id ? moved : slot))
  return writeBack(board, compact(visible, moved.id))
}

/**
 * 移除一个组件：记入 hidden，其余收拢补位
 * @param board 布局
 * @param specs 注册表给出的组件
 * @param id 组件标识
 * @returns 新布局
 */
export function hideWidget(board: Board, specs: readonly WidgetSpec[], id: string): Board {
  if (board.hidden.includes(id)) return board
  const next: Board = { slots: [...board.slots], hidden: [...board.hidden, id] }
  return writeBack(next, compact(visibleOf(next, specs)))
}

/**
 * 添加回一个此前移除的组件
 *
 * 它回到自己原先的位置（`hidden` 期间该位置一直留着），其余组件绕开它 —— 与拖动落位
 * 取同一条规则，故「移除再添加」在版面上是一次可逆的动作。
 * @param board 布局
 * @param specs 注册表给出的组件
 * @param id 组件标识
 * @returns 新布局；该组件本不在移除之列时原样返回
 */
export function showWidget(board: Board, specs: readonly WidgetSpec[], id: string): Board {
  const hidden = board.hidden.filter(item => item !== id)
  if (hidden.length === board.hidden.length) return board
  const next: Board = { slots: [...board.slots], hidden }

  /*
   * 只在 hidden 里、连位置都没有过的标识：`defaultHidden` 的组件初次被添加时必然如此，
   * 落盘记录被手改过时也会如此。
   *
   * **此处自行补位，不能交给 `normalize`** —— 它见到不在 `slots` 里的 `defaultHidden`
   * 组件就会再记回 `hidden`（那正是它的职责），于是「添加显卡」成了一次没有反应的点击。
   */
  if (!next.slots.some(slot => slot.id === id)) {
    const spec = specs.find(item => item.id === id)
    if (spec === undefined) return normalize(next, specs)
    const { w, h } = sizeOf(spec)
    const visible = visibleOf(next, specs)
    const at = firstFree(visible, w, h)
    next.slots.push({ id, x: at.x, y: at.y, w, h })
    return writeBack(next, compact([...visible, { id, x: at.x, y: at.y, w, h }], id))
  }
  return writeBack(next, compact(visibleOf(next, specs), id))
}

/**
 * 序列化为落盘字符串
 * @param board 布局
 * @returns JSON 字符串
 */
export function serializeBoard(board: Board): string {
  return JSON.stringify({ v: VERSION, slots: board.slots, hidden: board.hidden })
}

/**
 * 是否为普通对象
 * @param value 待判断的值
 * @returns 是否为普通对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 解析落盘字符串
 *
 * 任何一处不合期望即整份退回默认布局：版本不认、JSON 坏了、`slots` 不是数组。
 * **不做迁移** —— 布局是半分钟就能重摆的东西，而一份迁移了一半的布局比默认布局更难解释。
 * @param raw localStorage 里的原文；未存过时为 null
 * @param specs 注册表给出的组件
 * @returns 布局
 */
export function parseBoard(raw: string | null, specs: readonly WidgetSpec[]): Board {
  const fresh: Board = { slots: [], hidden: [] }
  if (raw === null || raw === "") return normalize(fresh, specs)
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return normalize(fresh, specs)
  }
  if (!isRecord(data) || data.v !== VERSION || !Array.isArray(data.slots)) return normalize(fresh, specs)
  const slots: Slot[] = []
  const seen = new Set<string>()
  for (const item of data.slots) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id === "" || seen.has(item.id)) continue
    seen.add(item.id)
    slots.push({
      id: item.id,
      x: intOf(item.x, 0),
      y: intOf(item.y, 0),
      w: intOf(item.w, 1),
      h: intOf(item.h, 1)
    })
  }
  const hidden = Array.isArray(data.hidden)
    ? [...new Set(data.hidden.filter((value): value is string => typeof value === "string"))]
    : []
  return normalize({ slots, hidden }, specs)
}
