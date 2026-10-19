<script setup lang="ts">
/**
 * 模块职责：一页的组件板 —— 按 12 列栅格摆放注册在该页的组件，并提供编辑态
 * 依赖方向：依赖 grid（算位置）、registry（有哪些组件）、confirm（恢复默认前先问）
 * 生命周期：随所在页面；布局在每次落位后立即写入 localStorage
 * 注意事项：**编辑态只在宽屏提供。** 窄屏忽略 x/y/w 一律单列顺排（顺序即先上后左），
 *          此时屏幕上呈现的坐标与落盘的坐标不是同一套 —— 在窄屏拖动等于在编辑一份
 *          看不见的版面。故窄屏隐去整条工具条。
 *
 *          **移动期间只动 `transform`。** 被拖的那一格仍按起手时的栅格坐标定位，
 *          另叠一层位移跟着指针，落位后才写新坐标（设计系统第 4 条不允许过渡
 *          width/height/top/left）。改尺寸是逐格跳变，直接给出新的跨度，不涉过渡。
 *
 *          **其余组件在拖动期间就实时让开**，而不是等松手才动：让开这件事本身就是
 *          「松手会变成什么样」的答复，等松手才答复，使用者只能先试一次再撤销。
 *
 *          **让开的过渡只在拖动之外生效。** `TransitionGroup` 的 FLIP 把位置差写成内联
 *          transform，而拖动中那一格的 transform 正由 `styleOf` 占着 —— 两者写同一个属性
 *          必然打架。故拖动期间把 move class 换成不含 transform 过渡的类名（Vue 检测到即
 *          跳过 FLIP），让开仍是瞬时的；松手时 `drag` 已为 undefined，FLIP 恢复，那一格
 *          从手离开的地方滑进格位而非先跳回原处。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from "vue"
import WidgetCell from "./WidgetCell.vue"
import { askConfirm } from "../confirm.js"
import {
  COLUMNS,
  SUB_ROWS,
  applyMove,
  fitBoard,
  hideWidget,
  layoutKey,
  packBoard,
  parseBoard,
  rowsOf,
  serializeBoard,
  showWidget,
  toSubRows,
  visibleOf,
  type Board,
  type Slot
} from "../grid.js"
import { specsOf, widgetsOf } from "../registry.js"

const props = withDefaults(
  defineProps<{
    /** 页面标识，取 `ROUTES` 中的 id；组件由注册表按它筛出 */
    page: string
    /** 是否处于编辑态；未传时由本组件自行管理 */
    edit?: boolean
  }>(),
  { edit: undefined }
)

const emit = defineEmits<{
  (e: "update:edit", value: boolean): void
}>()

/** 内部编辑态；当父组件通过 prop 传入时以此为准 */
const localEdit = ref(false)
const editModel = computed({
  get: () => (props.edit !== undefined ? props.edit : localEdit.value),
  set: (v: boolean) => {
    if (props.edit !== undefined) emit("update:edit", v)
    else localEdit.value = v
  }
})

/** 窄屏阈值，与 styles.css 里那一处 `max-width` 同一个数 */
const NARROW = 700
/** 侧栏展开时，按内容区宽度决定是否改为单列。 */
const MIN_BOARD_WIDTH = 640

/** 行高兜底：读不到 `--grid-row` 时用它，与 styles.css 中的取值一致 */
const ROW_FALLBACK = 80

/** 默认版面在实测高度多久不变之后重排，见 `schedulePack` */
const PACK_SETTLE_MS = 1500

/**
 * 拖到离视口上下边缘多近就开始滚
 *
 * 取 72px：比一行格高（80px）略小。再大则「拖到屏幕中下部」就已触发，而那时使用者
 * 多半只是在挪位置；再小则要把指针几乎压到边框上才滚得动。
 */
const EDGE = 72

/**
 * 每一帧最多滚多少像素
 *
 * 滚动速度按「离边缘多近」在 0 到此值之间取，越近越快。恒速滚会让刚碰到边缘的那一下
 * 就窜出一大段，而使用者此刻要的只是「再往下一点」。
 */
const EDGE_SPEED = 18

/** 拖动中的状态 */
interface Drag {
  /** 被拖的组件 */
  id: string
  /** 在移动还是在改尺寸 */
  mode: "move" | "size"
  /** 起手时的指针横坐标 */
  fromX: number
  /** 起手时的指针纵坐标 */
  fromY: number
  /** 起手时的格子 */
  origin: Slot
  /** 指针横向位移 */
  dx: number
  /** 指针纵向位移 */
  dy: number
  /**
   * 指针此刻在视口里的纵坐标
   *
   * 与 `dy` 不能互相推算：`dy` 是相对起手点的位移，而边缘判定问的是「指针离视口上下沿
   * 还有多远」—— 页面一滚，同一个 `dy` 对应的视口位置就变了。故另记一份。
   */
  pointerY: number
  /**
   * 起手时认定的滚动容器
   *
   * 起手时定一次而非每帧现找：拖动期间布局不变，而每帧沿 DOM 向上跑一遍
   * `getComputedStyle` 是白花的开销。宽屏是 `.main`、窄屏是页面，见 `scrollHostOf`。
   */
  scrollHost: Element | Window
  /** 一列宽，起手时量一次 —— 拖动期间不会有人改窗口宽度 */
  colW: number
  /** 一细格的纵向步距：细格高加一道间隙 */
  rowPitch: number
  /** 列间间隙 */
  gap: number
}

/**
 * 一细格多高
 *
 * 一整行是 `--grid-row` 加一道 `--grid-gap`，均分成 {@link SUB_ROWS} 格。两者都随密度变，
 * 故每次现读而不缓存。
 * @param style 板的计算样式
 * @returns 像素
 */
function subRowOf(style: CSSStyleDeclaration): number {
  const row = Number.parseFloat(style.getPropertyValue("--grid-row")) || ROW_FALLBACK
  const gap = Number.parseFloat(style.getPropertyValue("--grid-gap")) || 0
  return (row + gap) / SUB_ROWS
}

/** 本页组件的栅格约束，`h` / `minH` 已换成细格 —— 板内一律按细格算 */
const specs = computed(() => specsOf(props.page).map(toSubRows))
const defs = computed(() => new Map(widgetsOf(props.page).map(def => [def.id, def])))

const host = ref<HTMLElement | undefined>(undefined)
const media = window.matchMedia(`(max-width: ${NARROW}px)`)
/** 是否窄屏单列 */
const stacked = ref(media.matches)
const drag = ref<Drag | undefined>(undefined)

/**
 * 读一次落盘的布局
 * @returns 原文；未存过或读不到时为 null
 */
function read(): string | null {
  try {
    return localStorage.getItem(layoutKey(props.page))
  } catch {
    return null
  }
}

const board = ref<Board>(parseBoard(read(), specs.value))

/** 版面还没落过盘：量完实测高度后按它重排一次，见 `packBoard` */
let packPending = read() === null
let packTimer: number | undefined

/** 落盘当前布局 */
function save(): void {
  packPending = false
  if (packTimer !== undefined) window.clearTimeout(packTimer)
  try {
    localStorage.setItem(layoutKey(props.page), serializeBoard(board.value))
  } catch {
    // 隐私模式下 localStorage 会抛。存不下就不存，代价是下次进来是默认布局
  }
}

/** 高度随内容的组件 */
const fitIds = computed(() => new Set(specs.value.filter(spec => spec.fit === true).map(spec => spec.id)))

/** 随内容组件实测所需的行数，由 `measure` 写入 */
const measured = ref<ReadonlyMap<string, number>>(new Map())

/** 计入实测高度的布局；窄屏行高本就按内容，不必改写 */
const fitted = computed<Board>(() =>
  stacked.value ? board.value : fitBoard(board.value, specs.value, measured.value)
)

/** 拖到此刻，被拖的组件会落在哪个格子；无拖动时 undefined */
const ghost = computed<Slot | undefined>(() => {
  const now = drag.value
  if (now === undefined) return undefined
  const dc = Math.round(now.dx / (now.colW + now.gap))
  const dr = Math.round(now.dy / now.rowPitch)
  if (now.mode === "move") {
    return { ...now.origin, x: now.origin.x + dc, y: Math.max(0, now.origin.y + dr) }
  }
  // 随内容的组件只改宽：高度由内容定，拖了也会被下一次实测改回去
  const dh = fitIds.value.has(now.id) ? 0 : dr
  return { ...now.origin, w: now.origin.w + dc, h: now.origin.h + dh }
})

/** 计入拖动的布局：其余组件据此实时让开 */
const preview = computed<Board>(() => {
  const target = ghost.value
  return target === undefined ? fitted.value : applyMove(fitted.value, specs.value, target)
})

/** 要渲染的格子，顺序即先上后左 */
const cells = computed(() =>
  visibleOf(preview.value, specs.value).flatMap(slot => {
    const def = defs.value.get(slot.id)
    return def === undefined ? [] : [{ slot, def }]
  })
)

/** 已被移除、可在编辑态添加回来的组件 */
const removed = computed(() => widgetsOf(props.page).filter(def => board.value.hidden.includes(def.id)))

/**
 * 编辑态背景网格的每一格，值即内联样式
 *
 * **画的是真格子，不是背景渐变**：列宽是 `1fr` 的百分比，而渐变只认 px 或百分比中的
 * 一种 —— 用 px 画则每换一次窗口宽度就与列边界错开。让同一套栅格规则去排一批空 div，
 * 边界必然一致。
 *
 * **每格都显式给坐标，不靠自动排布** —— 自动排布会绕开已定位的元素，于是底网恰在有
 * 卡片的地方缺格，成了一张「有洞的网」。
 *
 * 多给两行以示意「往下还能放」。拖动期间按 `preview` 算，故往下拖时网格随之长出来。
 */
const gridCells = computed<CSSProperties[]>(() => {
  // 底网按细格画：卡片的上下沿都落在细格边上，底网画粗了两者就对不上
  const rows = rowsOf(visibleOf(preview.value, specs.value)) + 2 * SUB_ROWS
  const out: CSSProperties[] = []
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < COLUMNS; x += 1) out.push({ gridColumn: `${x + 1}`, gridRow: `${y + 1}` })
  }
  return out
})

/**
 * 一个格子的定位
 * @param slot 该格子的位置
 * @returns 内联样式
 */
function styleOf(slot: Slot): CSSProperties {
  // 窄屏交给 CSS 单列顺排，此处不给任何坐标
  if (stacked.value) return {}
  const now = drag.value
  if (now?.mode === "move" && now.id === slot.id) {
    return {
      gridColumn: `${now.origin.x + 1} / span ${now.origin.w}`,
      gridRow: `${now.origin.y + 1} / span ${now.origin.h}`,
      transform: `translate(${now.dx}px, ${now.dy}px)`
    }
  }
  return { gridColumn: `${slot.x + 1} / span ${slot.w}`, gridRow: `${slot.y + 1} / span ${slot.h}` }
}

/** 落点示意框的定位；取的是**收拢之后**的位置，故它显示的就是松手后的实况 */
const ghostStyle = computed<CSSProperties>(() => {
  const at = cells.value.find(cell => cell.slot.id === drag.value?.id)?.slot
  if (at === undefined) return { display: "none" }
  return { gridColumn: `${at.x + 1} / span ${at.w}`, gridRow: `${at.y + 1} / span ${at.h}` }
})

/**
 * 起手
 * @param event 指针事件
 * @param slot 被拖的格子
 * @param mode 移动还是改尺寸
 */
function begin(event: PointerEvent, slot: Slot, mode: "move" | "size"): void {
  const box = host.value
  if (box === undefined || stacked.value || !editModel.value) return
  const style = getComputedStyle(box)
  const gap = Number.parseFloat(style.columnGap) || 0
  drag.value = {
    id: slot.id,
    mode,
    fromX: event.clientX,
    fromY: event.clientY,
    origin: { ...slot },
    dx: 0,
    dy: 0,
    pointerY: event.clientY,
    scrollHost: scrollHostOf(box),
    gap,
    rowPitch: subRowOf(style),
    colW: (box.clientWidth - gap * (COLUMNS - 1)) / COLUMNS
  }
  // 捕获指针：拖出格子外、拖到窗口外再松手，事件仍回到这里，不会漏掉落位
  if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId)
  /*
   * 边缘滚动的循环即刻开始，不等指针挨到边缘
   *
   * 按 `pointermove` 触发的话，指针停在边缘带里不动时页面就停住了 —— 而那正是
   * 「我要往下翻」的姿势。循环里每帧自行判断是否该滚（见 `edgeStep`）。
   */
  edgeStart()
}

/** 边缘自动滚动的帧句柄；未在滚动时 undefined */
let edgeTimer: number | undefined

/**
 * 找到真正在滚的那个祖先
 *
 * **不能写死 window。** 宽屏下滚动容器是 `.main`（见 styles.css 的
 * `min-width: 860px` 一段），此时 `window.scrollBy` 什么都不做 —— 表现为拖着卡片
 * 顶到屏幕下沿，页面不动，够不到下面的行。窄屏下滚的仍是页面，故两种都要认。
 *
 * 逐级向上找第一个「能滚且溢出」的祖先，找不到就回退到页面。
 * @param from 自哪个元素起向上找
 * @returns 滚动容器；页面本身在滚时给 window
 */
function scrollHostOf(from: Element | undefined): Element | Window {
  let at: Element | null = from ?? null
  while (at !== null && at !== document.body) {
    const overflow = getComputedStyle(at).overflowY
    if ((overflow === "auto" || overflow === "scroll") && at.scrollHeight > at.clientHeight) return at
    at = at.parentElement
  }
  return window
}

/**
 * 滚动容器当前的纵向滚动量
 * @param host 滚动容器
 * @returns 滚动量（px）
 */
function scrollTopOf(host: Element | Window): number {
  return host instanceof Window ? host.scrollY : host.scrollTop
}

/**
 * 滚动容器在视口里的上下边界
 *
 * 边缘带要按**容器**的边界算，不按视口：宽屏下 `.main` 有上内边距，按视口算会让
 * 边缘带落在侧栏与顶部留白上，指针还没挨到内容的边就开始滚。
 * @param host 滚动容器
 * @returns 上下边界的视口坐标
 */
function boundsOf(host: Element | Window): { top: number; bottom: number } {
  if (host instanceof Window) return { top: 0, bottom: window.innerHeight }
  const box = host.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom }
}

/**
 * 一帧的边缘滚动
 *
 * **滚动量要回填到 `fromY` 上。** 位移是 `clientY - fromY`，而容器滚过之后，同一个
 * `clientY` 对应的栅格位置已经往上移了 —— 不回填则被拖的那一格会脱离指针往上飘，
 * 且落点算的是滚动前的行。把 `fromY` 减去实际滚动量，位移便自然含进这一段。
 *
 * 取**实际**滚动量而非请求量：滚到尽头时 `scrollBy` 什么都不做，此时若按请求量回填，
 * 那一格会随每一帧持续下移，而页面一动不动。
 */
function edgeStep(): void {
  const now = drag.value
  if (now === undefined) {
    edgeTimer = undefined
    return
  }

  const host = now.scrollHost
  const edges = boundsOf(host)
  const top = now.pointerY - (edges.top + EDGE)
  const bottom = now.pointerY - (edges.bottom - EDGE)
  // 两侧都没进入边缘带：这一帧不滚，但循环留着 —— 指针随时会再挨过去
  const push = top < 0 ? top : bottom > 0 ? bottom : 0
  if (push !== 0) {
    // 越靠边越快，至多 EDGE_SPEED：恒速会让刚碰到边缘就窜出一大段
    const ratio = Math.min(1, Math.abs(push) / EDGE)
    const before = scrollTopOf(host)
    host.scrollBy({ top: Math.sign(push) * EDGE_SPEED * ratio })
    now.fromY -= scrollTopOf(host) - before
    now.dy = now.pointerY - now.fromY
  }
  edgeTimer = requestAnimationFrame(edgeStep)
}

/**
 * 起一趟边缘滚动的循环
 *
 * 已在跑时不再起第二趟：两趟循环各自滚一份，页面会以双倍速度窜出去。
 */
function edgeStart(): void {
  if (edgeTimer !== undefined) return
  edgeTimer = requestAnimationFrame(edgeStep)
}

/** 停下边缘滚动 */
function edgeStop(): void {
  if (edgeTimer !== undefined) cancelAnimationFrame(edgeTimer)
  edgeTimer = undefined
}

/**
 * 跟随指针
 * @param event 指针事件
 */
function follow(event: PointerEvent): void {
  const now = drag.value
  if (now === undefined) return
  now.pointerY = event.clientY
  now.dx = event.clientX - now.fromX
  now.dy = event.clientY - now.fromY
}

/** 落位：把示意框所在的位置写成真的 */
function settle(): void {
  edgeStop()
  const target = ghost.value
  drag.value = undefined
  if (target === undefined) return
  board.value = applyMove(fitted.value, specs.value, target)
  save()
}

/**
 * 方向键微调
 *
 * 把手是个按钮、本就能用 Tab 走到。按住 Shift 改尺寸，与拖右下角同义。
 *
 * **调整之后须把焦点放回原处**：`cells` 按先上后左排序，一次移动会改变数组顺序，
 * Vue 的带键 diff 随之用 `insertBefore` 搬走该节点，浏览器让被重新插入的元素失焦。
 * 不补这一手，键盘使用者挪一格之后得重新 Tab 回来才能挪第二格。
 *
 * **Shift 一支在不可调大小的组件上直接不受理**：`clampSlot` 反正会把宽高夹回声明值，
 * 受理它只是白走一遍 `applyMove` 与 `save()`，而使用者看到的是「按了没反应」。
 * @param event 键盘事件
 * @param slot 当前格子
 * @param free 该组件是否可改大小
 */
function onKey(event: KeyboardEvent, slot: Slot, free: boolean): void {
  const step: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
  }
  const delta = step[event.key]
  if (delta === undefined) return
  if (event.shiftKey && !free) return
  // 随内容的组件改不了高，Shift + 上下在它身上同样不受理
  if (event.shiftKey && delta[1] !== 0 && fitIds.value.has(slot.id)) return
  event.preventDefault()
  // 上下一次走一细格，与编辑态底网的一格同高
  const next = event.shiftKey
    ? { ...slot, w: slot.w + delta[0], h: slot.h + delta[1] }
    : { ...slot, x: slot.x + delta[0], y: slot.y + delta[1] }
  board.value = applyMove(fitted.value, specs.value, next)
  save()
  void nextTick(() => {
    host.value?.querySelector<HTMLElement>(`.witem[data-widget="${slot.id}"] .whandle`)?.focus()
  })
}

/**
 * 移除一个组件
 * @param id 组件标识
 */
function remove(id: string): void {
  board.value = hideWidget(fitted.value, specs.value, id)
  save()
}

/**
 * 添加回一个组件
 * @param id 组件标识
 */
function add(id: string): void {
  board.value = showWidget(fitted.value, specs.value, id)
  save()
}

/** 恢复默认布局：位置、大小与「已移除」的记录一并回到出厂状态 */
async function reset(): Promise<void> {
  const ok = await askConfirm({
    title: "恢复默认布局",
    body: "本页组件的位置、大小，以及「已移除」的记录都会回到出厂状态。",
    okText: "恢复",
    danger: true
  })
  if (!ok) return
  try {
    localStorage.removeItem(layoutKey(props.page))
  } catch {
    // 删不掉也无妨：下面这行已按默认布局重建，再有一次落位就把旧值盖掉了
  }
  board.value = parseBoard(null, specs.value)
  packPending = true
  scheduleMeasure()
}

/**
 * 一张卡片的内容本身有多高
 *
 * **不取卡片的 `scrollHeight`**：卡片撑满格子，格子比内容高时它报的是格子高，量不出「可以再矮」。
 * 改按子元素的下沿算，与格子当前多高无关，故缩放格子不会反过来改变量得的数。
 * @param card 格内卡片
 * @returns 含内边距与边框的像素高度
 */
function naturalHeight(card: HTMLElement): number {
  const style = getComputedStyle(card)
  const padTop = Number.parseFloat(style.paddingTop) || 0
  const padBottom = Number.parseFloat(style.paddingBottom) || 0
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0
  const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0
  let bottom = 0
  for (const child of card.children) {
    if (!(child instanceof HTMLElement) || child.offsetParent === null) continue
    const position = getComputedStyle(child).position
    if (position === "absolute" || position === "fixed") continue
    const marginBottom = Number.parseFloat(getComputedStyle(child).marginBottom) || 0
    // 卡片是 static，子元素的 offsetParent 是外面的 `.witem`，故两者的 offsetTop 同一个原点
    const top = child.offsetParent === card ? child.offsetTop + borderTop : child.offsetTop - card.offsetTop
    bottom = Math.max(bottom, top + child.offsetHeight + marginBottom)
  }
  if (bottom === 0) return 0
  return Math.max(bottom, borderTop + padTop) + padBottom + borderBottom
}

/** 已在观察的元素；对同一元素再 `observe` 一次会补发一次回调，于是每帧都量、永不停 */
const watched = new WeakSet<Element>()
let measureFrame: number | undefined

/** 尺寸或内容一变就下一帧重量；量的是整板，合并成一次 */
function scheduleMeasure(): void {
  if (measureFrame !== undefined) return
  measureFrame = requestAnimationFrame(() => {
    measureFrame = undefined
    measure()
  })
}

const resizeWatch = new ResizeObserver(() => {
  onMedia()
  scheduleMeasure()
})
const mutationWatch = new MutationObserver(scheduleMeasure)

/**
 * 量一遍随内容的组件，并把行数写回 `measured`
 *
 * 行数取上整：差一像素也要多给一行，否则末行被裁、长出滚动条。
 */
function measure(): void {
  const box = host.value
  if (box === undefined || stacked.value || fitIds.value.size === 0) return
  const style = getComputedStyle(box)
  const pitch = subRowOf(style)
  // 跨 k 细格的格子高 k × 步距 − 一道间隙，故内容高加一道间隙再折成细格
  const gap = Number.parseFloat(style.getPropertyValue("--grid-gap")) || 0
  const next = new Map<string, number>()
  for (const item of box.querySelectorAll<HTMLElement>(".witem[data-widget]")) {
    const id = item.dataset.widget ?? ""
    const card = item.firstElementChild
    if (!fitIds.value.has(id) || !(card instanceof HTMLElement)) continue
    for (const el of [card, ...card.children]) {
      if (watched.has(el)) continue
      watched.add(el)
      resizeWatch.observe(el)
    }
    if (!watched.has(item)) {
      watched.add(item)
      mutationWatch.observe(item, { childList: true, subtree: true, characterData: true })
    }
    const height = naturalHeight(card)
    // 0.5px 的余量吃掉子像素取整：恰好装下的内容不该因此多占一格
    if (height > 0) next.set(id, Math.max(1, Math.ceil((height + gap - 0.5) / pitch)))
  }
  const same = next.size === measured.value.size && [...next].every(([id, n]) => measured.value.get(id) === n)
  if (!same) measured.value = next
  // 只在量值变了（或尚未排期）时重新计时，否则每拍刷新的运行时长会把它一直往后推
  if (packPending && next.size > 0 && (!same || packTimer === undefined)) schedulePack()
}

/**
 * 实测高度稳定一阵之后重排默认版面并落盘
 *
 * 等数据到齐：首拍量到的多是「加载中」那一行，按它排会把插件组件塞进错的一栏。
 * 落盘之后不再重排，否则告警多一条，下次进来版面就换了一副样子。
 */
function schedulePack(): void {
  if (packTimer !== undefined) window.clearTimeout(packTimer)
  packTimer = window.setTimeout(() => {
    packTimer = undefined
    if (!packPending || drag.value !== undefined) return
    board.value = packBoard(board.value, specs.value, measured.value)
    save()
  }, PACK_SETTLE_MS)
}

// 组件进出、窄宽切换之后格子换了一批，要重新挂观察并量一次
watch([() => cells.value.length, stacked], () => void nextTick(scheduleMeasure))

/** 记下窄屏与否；转入窄屏时退出编辑态 —— 窄屏下呈现的坐标不是落盘的那一套 */
function onMedia(): void {
  stacked.value = media.matches || (host.value !== undefined && host.value.clientWidth < MIN_BOARD_WIDTH)
  if (stacked.value) editModel.value = false
}

onMounted(() => {
  media.addEventListener("change", onMedia)
  // 板宽一变，表格与长路径就可能折行，内容高度跟着变
  if (host.value !== undefined) resizeWatch.observe(host.value)
  onMedia()
  scheduleMeasure()
})

onUnmounted(() => {
  media.removeEventListener("change", onMedia)
  // 拖动中换页：rAF 循环不会自己停，留着就是一个每帧都在跑、却没人看的滚动
  edgeStop()
  resizeWatch.disconnect()
  mutationWatch.disconnect()
  if (packTimer !== undefined) window.clearTimeout(packTimer)
  if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
})
</script>

<template>
  <!-- 工具条整条只在宽屏出现：窄屏没有编辑态，一枚点不出结果的按钮比没有按钮更糟 -->
  <div v-if="stacked && editModel" class="board-bar">
    <p class="hint">内容区太窄，单列排布下不能编辑布局。收起侧栏或加宽窗口后再试。</p>
  </div>
  <div v-if="!stacked && defs.size > 0" class="board-bar">
    <p v-if="editModel" class="hint">
      拖动组件调整位置，拖右下角调整大小（高度随内容的组件只能拖右缘改宽）。把手上按方向键可逐格微调，按住 Shift 则改大小。
    </p>
    <button v-if="editModel" type="button" @click="void reset()">恢复默认布局</button>
  </div>

  <div v-if="editModel && !stacked && removed.length > 0" class="board-add">
    <span class="hint">已移除：</span>
    <button v-for="def in removed" :key="def.id" type="button" @click="add(def.id)">＋ {{ def.title }}</button>
  </div>

  <div ref="host" class="board" :class="{ stacked, editing: editModel, dragging: drag !== undefined }">
    <!--
      编辑态的背景网格：一批空格子，靠同一套栅格规则自然对齐列边界（理由见 gridCells）

      **必须是 `.board` 的直接子元素**，否则它落不进这套栅格；也**必须排在组件之前**，
      两者同为栅格项、都不设 z-index 时由 DOM 顺序定叠放，写在后面会盖住卡片。
      窄屏不画：那时忽略 x/y/w 单列顺排，一张 12 列的网格与屏上所见毫无关系。
    -->
    <template v-if="editModel && !stacked">
      <div
        v-for="(at, i) in gridCells"
        :key="`g${i}`"
        class="wgrid-cell"
        :style="at"
        aria-hidden="true"
      />
    </template>

    <!--
      不给 TransitionGroup 写 `tag`：那样会多出一层包裹元素，而栅格要求格子是 `.board`
      的直接子元素。无 tag 时它渲染为片段，格子仍直接落在板上。
      落点示意框留在组外 —— 它每次拖动都进出一趟，不该被当作一个会「让开」的格子。
    -->
    <TransitionGroup name="wgrid" :move-class="drag === undefined ? 'wgrid-move' : 'wgrid-still'">
      <div
        v-for="cell in cells"
        :key="cell.slot.id"
        class="witem"
        :class="{ dragging: drag?.id === cell.slot.id, fit: fitIds.has(cell.slot.id) }"
        :style="styleOf(cell.slot)"
        :data-widget="cell.slot.id"
        :data-panel="cell.def.pkg"
      >
        <WidgetCell :def="cell.def" />

        <!--
          编辑态的三件套。把手覆盖整格而非只做一条标题栏：编辑态下组件内容已不可点
          （见 styles.css 中 `.board.editing` 的 pointer-events），把手做小只会增加
          「怎么拖不动」的机会。× 与右下角压在把手之上，故仍各自可点。

          把手上不写可见的标题：一枚组件名药丸会压住计数块的数值，而那个词在格子里
          本就写着。组件名对读屏器由 `aria-label` 供给。
        -->
        <template v-if="editModel">
          <button
            class="whandle"
            type="button"
            :aria-label="`移动 ${cell.def.title}`"
            @pointerdown="begin($event, cell.slot, 'move')"
            @pointermove="follow"
            @pointerup="settle"
            @pointercancel="settle"
            @keydown="onKey($event, cell.slot, cell.def.layout.resizable === true)"
          />
          <button
            class="wdrop"
            type="button"
            :aria-label="`移除 ${cell.def.title}`"
            @click="remove(cell.slot.id)"
          >
            ×
          </button>
<!--
            右下角只在该组件声明可调时出现

            画一个拖不动的把手比不画更糟：使用者会试三次，然后当成 bug。尺寸固定的
            组件（多数计数块）此后没有这枚把手，也就没有那三次尝试。
          -->
          <button
            v-if="cell.def.layout.resizable === true"
            class="wsize"
            :class="{ 'wsize-x': cell.def.layout.fit === true }"
            type="button"
            :aria-label="cell.def.layout.fit === true ? `调整 ${cell.def.title} 的宽度` : `调整 ${cell.def.title} 的大小`"
            @pointerdown="begin($event, cell.slot, 'size')"
            @pointermove="follow"
            @pointerup="settle"
            @pointercancel="settle"
          />
        </template>
      </div>
    </TransitionGroup>

    <!-- 落点示意框：只在移动时出现。改尺寸时格子本身就在逐格跳变，再多一个框反而乱 -->
    <div v-if="drag?.mode === 'move'" class="wghost" :style="ghostStyle" />
  </div>

  <p v-if="cells.length === 0 && defs.size > 0" class="hint">
    本页的组件都被移除了。点「编辑组件」可以添加回来。
  </p>
</template>
