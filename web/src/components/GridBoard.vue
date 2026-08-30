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
import { computed, nextTick, onMounted, onUnmounted, ref, type CSSProperties } from "vue"
import WidgetCell from "./WidgetCell.vue"
import { askConfirm } from "../confirm.js"
import {
  COLUMNS,
  applyMove,
  hideWidget,
  layoutKey,
  parseBoard,
  rowsOf,
  serializeBoard,
  showWidget,
  visibleOf,
  type Board,
  type Slot
} from "../grid.js"
import { specsOf, widgetsOf } from "../registry.js"

const props = defineProps<{
  /** 页面标识，取 `ROUTES` 中的 id；组件由注册表按它筛出 */
  page: string
}>()

/** 窄屏阈值，与 styles.css 里那一处 `max-width` 同一个数 */
const NARROW = 700

/** 行高兜底：读不到 `--grid-row` 时用它，与 styles.css 中的取值一致 */
const ROW_FALLBACK = 80

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
  /** 一行高 */
  rowH: number
  /** 格间间隙 */
  gap: number
}

const specs = computed(() => specsOf(props.page))
const defs = computed(() => new Map(widgetsOf(props.page).map(def => [def.id, def])))

const host = ref<HTMLElement | undefined>(undefined)
const media = window.matchMedia(`(max-width: ${NARROW}px)`)
/** 是否窄屏单列 */
const stacked = ref(media.matches)
/** 是否处于编辑态 */
const edit = ref(false)
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

/** 落盘当前布局 */
function save(): void {
  try {
    localStorage.setItem(layoutKey(props.page), serializeBoard(board.value))
  } catch {
    // 隐私模式下 localStorage 会抛。存不下就不存，代价是下次进来是默认布局
  }
}

/** 拖到此刻，被拖的组件会落在哪个格子；无拖动时 undefined */
const ghost = computed<Slot | undefined>(() => {
  const now = drag.value
  if (now === undefined) return undefined
  const dc = Math.round(now.dx / (now.colW + now.gap))
  const dr = Math.round(now.dy / (now.rowH + now.gap))
  if (now.mode === "move") {
    return { ...now.origin, x: now.origin.x + dc, y: Math.max(0, now.origin.y + dr) }
  }
  return { ...now.origin, w: now.origin.w + dc, h: now.origin.h + dr }
})

/** 计入拖动的布局：其余组件据此实时让开 */
const preview = computed<Board>(() => {
  const target = ghost.value
  return target === undefined ? board.value : applyMove(board.value, specs.value, target)
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
  const rows = rowsOf(visibleOf(preview.value, specs.value)) + 2
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
  if (box === undefined || stacked.value || !edit.value) return
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
    rowH: Number.parseFloat(style.getPropertyValue("--grid-row")) || ROW_FALLBACK,
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
  board.value = applyMove(board.value, specs.value, target)
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
  event.preventDefault()
  const next = event.shiftKey
    ? { ...slot, w: slot.w + delta[0], h: slot.h + delta[1] }
    : { ...slot, x: slot.x + delta[0], y: slot.y + delta[1] }
  board.value = applyMove(board.value, specs.value, next)
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
  board.value = hideWidget(board.value, specs.value, id)
  save()
}

/**
 * 添加回一个组件
 * @param id 组件标识
 */
function add(id: string): void {
  board.value = showWidget(board.value, specs.value, id)
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
}

/** 记下窄屏与否；转入窄屏时退出编辑态 —— 窄屏下呈现的坐标不是落盘的那一套 */
function onMedia(): void {
  stacked.value = media.matches
  if (stacked.value) edit.value = false
}

onMounted(() => {
  media.addEventListener("change", onMedia)
})

onUnmounted(() => {
  media.removeEventListener("change", onMedia)
  // 拖动中换页：rAF 循环不会自己停，留着就是一个每帧都在跑、却没人看的滚动
  edgeStop()
})
</script>

<template>
  <!-- 工具条整条只在宽屏出现：窄屏没有编辑态，一枚点不出结果的按钮比没有按钮更糟 -->
  <div v-if="!stacked && defs.size > 0" class="board-bar">
    <p v-if="edit" class="hint">
      拖动组件调整位置，拖右下角调整大小。把手上按方向键可逐格微调，按住 Shift 则改大小。
    </p>
    <button v-if="edit" type="button" @click="void reset()">恢复默认布局</button>
    <button type="button" :class="{ primary: edit }" @click="edit = !edit">
      {{ edit ? "完成" : "编辑组件" }}
    </button>
  </div>

  <div v-if="edit && removed.length > 0" class="board-add">
    <span class="hint">已移除：</span>
    <button v-for="def in removed" :key="def.id" type="button" @click="add(def.id)">＋ {{ def.title }}</button>
  </div>

  <div ref="host" class="board" :class="{ stacked, editing: edit }">
    <!--
      编辑态的背景网格：一批空格子，靠同一套栅格规则自然对齐列边界（理由见 gridCells）

      **必须是 `.board` 的直接子元素**，否则它落不进这套栅格；也**必须排在组件之前**，
      两者同为栅格项、都不设 z-index 时由 DOM 顺序定叠放，写在后面会盖住卡片。
      窄屏不画：那时忽略 x/y/w 单列顺排，一张 12 列的网格与屏上所见毫无关系。
    -->
    <template v-if="edit && !stacked">
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
        :class="{ dragging: drag?.id === cell.slot.id }"
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
        <template v-if="edit">
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
            type="button"
            :aria-label="`调整 ${cell.def.title} 的大小`"
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
