<script setup lang="ts">
/**
 * 模块职责：日志页 —— 历史回看与 WebSocket 实时推送，可按级别、作用域、关键字过滤
 * 依赖方向：依赖 api / format / types
 * 生命周期：挂载时拉取历史并建立连接；卸载时必须关闭连接
 * 注意事项：**历史与实时是两条独立通道，这是内核的刻意设计。** `GET logs` 取一屏历史，`WS logs` 只推
 *          此后新产生的记录。合并成一条（连接建立后先补发历史）会丢日志：握手回调里同步发出的第一帧
 *          在部分客户端上先于 open 事件到达而被丢弃，而缺一段历史最不易察觉。
 *
 *          过滤条件写在握手的查询串里，改条件要**重建连接** —— 服务端在握手时就固化过滤器，故不存在
 *          「配置帧到达前已推送了不该推的记录」这个窗口。
 *
 *          缓冲区有上限（`MAX_LINES`）—— 无上限数组开一整天会让标签页占几百 MB。
 *
 *          **每条记录的高度是固定的：消息之前一行，消息本身最多两行。** 时间、级别、作用域三列一律
 *          `nowrap`，消息由 `logline.ts` 在**字符串层面**截成「头部 + 省略号 + 尾部两字」，
 *          `-webkit-line-clamp` 仅作硬上限兜底 —— 它的省略号只在末尾，而日志的尾巴常是要看的那段
 *          （错误码、URL 末节）。
 *
 *          **列宽只量一次，不逐行量**（窗口尺寸变化时重量）：两千行逐行比对 `scrollHeight` 是两千次
 *          布局读取，且每来一条新日志就要重做一遍。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import { get, openSocket } from "../api.js"
import { clock, errorText } from "../format.js"
import { elide } from "../logline.js"
import PageHeader from "../components/PageHeader.vue"
import type { LogPage, LogRecord } from "../types.js"

/** 内存中保留的最大行数 */
const MAX_LINES = 2000

/** 量列宽时探针里放多少个半角字符 —— 取多个再平均，避免单字符的次像素误差 */
const PROBE_TEXT = "0000000000"

/**
 * 可选级别，取值与顺序须与内核 LOG_LEVELS 一致（`silent` 除外）
 *
 * 保留英文取值而仅在药丸上附中文：`value` 要原样进入握手的查询串，
 * 且日志行内的级别标记同样是英文 —— 两处一致方能对照。
 *
 * 不列出内核 LOG_LEVELS 中的 `silent`：它高于全部实际级别，
 * 没有任何一条记录以该级别产生，作为筛选项永远筛出空集。
 */
const LEVELS: readonly { value: string; label: string }[] = [
  { value: "trace", label: "追踪" },
  { value: "debug", label: "调试" },
  { value: "info", label: "信息" },
  { value: "warn", label: "警告" },
  { value: "error", label: "错误" },
  { value: "fatal", label: "致命" }
]

const records = ref<LogRecord[]>([])
const file = ref("")
const error = ref("")
const scope = ref("")
const keyword = ref("")
const live = ref(true)
const connected = ref(false)
const box = ref<HTMLElement | undefined>(undefined)
let socket: WebSocket | undefined

/**
 * 已勾选的级别
 *
 * 空集表示不限级别，而非"一条都不要"：筛选器的空状态应当等同于"未筛选"，
 * 这也使首次进入页面时无须预先勾上全部六项。
 */
const picked = ref<string[]>([])

/**
 * 上一次向服务端要过的阈值
 *
 * 用于判断勾选变化后手上的数据是否仍是超集。`undefined` 表示要过"不限级别"，
 * 那是最宽的一档，此后任何勾选都只会收窄，无须重新取。
 */
const served = ref<string | undefined>(undefined)

/**
 * 级别在 LEVELS 中的序号，越小越低
 * @param value 级别取值；undefined 视作最低（即不限级别）
 * @returns 序号
 */
function rankOf(value: string | undefined): number {
  if (value === undefined) return -1
  const at = LEVELS.findIndex(item => item.value === value)
  return at < 0 ? -1 : at
}

/**
 * 送给服务端的级别阈值
 *
 * 服务端的 `level` 参数是**阈值**语义（该级别及以上），表达不了「要 trace 与 fatal、
 * 但不要中间那几档」。故送出所选级别中**最低**的那一档，得到一个超集，
 * 再由 `keep()` 在前端精确筛一遍。
 * @returns 阈值级别；不限级别时 undefined
 */
function thresholdOf(): string | undefined {
  if (picked.value.length === 0) return undefined
  let lowest = LEVELS.length - 1
  for (const value of picked.value) {
    const at = LEVELS.findIndex(item => item.value === value)
    if (at >= 0 && at < lowest) lowest = at
  }
  return LEVELS[lowest]?.value
}

/**
 * 该记录是否属于当前勾选的级别
 *
 * 服务端送来的是超集（见 `thresholdOf`），故历史与实时两条通道都要过这一道。
 * @param rec 一条日志
 * @returns 是否保留
 */
function keep(rec: LogRecord): boolean {
  return picked.value.length === 0 || picked.value.includes(rec.level)
}

/**
 * 实际显示的记录
 *
 * **缓冲区存原始记录，筛选只作用于显示。** 若在收到时就按级别丢弃，取消勾选后那些
 * 记录已不在内存里，症状是「放宽筛选反而没有日志」。
 */
const shown = computed(() => records.value.filter(keep))

/** 消息列一行可容纳多少个半角位；量出来之前为 0，此时不作截断 */
const cols = ref(0)

/** 量列宽用的探针元素 */
const probe = ref<HTMLElement | undefined>(undefined)

/**
 * 已展开的记录
 *
 * 以**记录对象本身**为键而非行号：缓冲区满了之后从头部丢弃，行号会整体前移，
 * 按行号记会导致展开状态跳到别的行上去。
 */
const opened = ref<Set<LogRecord>>(new Set())

/**
 * 量一次列宽
 *
 * 探针取 `.logs` 内的一个隐藏元素，字族字号由其继承而来，无须在此重复一份字体常量。
 * 消息列的宽度取自实际渲染出的那一列 —— 照 `grid-template-columns` 在 JS 里再算一遍
 * 会与 CSS 分叉。
 */
function measure(): void {
  const probeEl = probe.value
  const boxEl = box.value
  if (probeEl === undefined || boxEl === undefined) return
  const advance = probeEl.getBoundingClientRect().width / PROBE_TEXT.length
  const msgEl = boxEl.querySelector(".log-msg")
  if (advance <= 0 || msgEl === null) return
  // 下限 8：窗口被拖到极窄时算出 0 会使截断退化为不截断
  cols.value = Math.max(8, Math.floor(msgEl.getBoundingClientRect().width / advance))
}

/** 一行日志的呈现形态 */
interface Row {
  /** 原记录 */
  rec: LogRecord
  /** 完整正文（含堆栈） */
  full: string
  /** 折叠态下显示的正文 */
  brief: string
  /** 是否确实被截断 —— 未截断的行不给展开按钮 */
  clipped: boolean
  /** 当前是否展开 */
  open: boolean
}

/** 待渲染的行 */
const rows = computed<Row[]>(() =>
  shown.value.map(rec => {
    // 堆栈接在正文之后：它与正文同属一条记录，分成两个元素会各自算一次两行上限
    const full = rec.stack === undefined || rec.stack === "" ? rec.msg : `${rec.msg}\n${rec.stack}`
    const brief = elide(full, cols.value)
    return { rec, full, brief, clipped: brief !== full, open: opened.value.has(rec) }
  })
)

/**
 * 展开或收起一行
 *
 * 顺带剔除已被缓冲区丢弃的记录：不清理的话，长时间挂着的页面会攒下一份只增不减的
 * 集合，而那些记录早已不在界面上。
 * @param rec 记录
 */
function toggle(rec: LogRecord): void {
  const next = new Set<LogRecord>()
  const alive = new Set(records.value)
  for (const item of opened.value) if (alive.has(item) && item !== rec) next.add(item)
  if (!opened.value.has(rec)) next.add(rec)
  opened.value = next
}

/**
 * 切换一个级别的勾选状态
 *
 * 不重新拉取也不重建连接：勾选只收窄显示，而服务端送来的已是超集。
 * 唯一需要重新握手的情形是**放宽**到比当前阈值更低的级别，此时超集不再够用 ——
 * 由 `watch(picked)` 判定并重建。
 * @param value 级别取值
 */
function toggleLevel(value: string): void {
  picked.value = picked.value.includes(value) ? picked.value.filter(v => v !== value) : [...picked.value, value]
}

/**
 * 构造查询串，并记下这次实际送出的阈值
 *
 * `served` 在此处赋值而非在调用点：历史与实时两条通道都要经过本函数，
 * 写在这里保证「送出的阈值」与「记下的阈值」不可能分叉。
 * @returns 形如 `?level=warn&scope=kernel`
 */
function queryString(): string {
  const params = new URLSearchParams()
  const threshold = thresholdOf()
  served.value = threshold
  if (threshold !== undefined) params.set("level", threshold)
  if (scope.value !== "") params.set("scope", scope.value)
  if (keyword.value !== "") params.set("keyword", keyword.value)
  const text = params.toString()
  return text === "" ? "" : `?${text}`
}

/**
 * 当前勾选是否已超出服务端那一份超集的范围
 *
 * 服务端按阈值推送，`served` 是上次握手时送出的那一档。勾选放宽到比它更低的级别时，
 * 那些记录压根没被推过来 —— 此时必须重新握手，否则药丸亮着而日志区一条不增。
 * @returns 是否需要重新取数
 */
function outOfRange(): boolean {
  const wanted = thresholdOf()
  // 由「限定某几档」放宽为「不限级别」：超集不再够用
  if (wanted === undefined) return served.value !== undefined
  if (served.value === undefined) return false
  return LEVELS.findIndex(i => i.value === wanted) < LEVELS.findIndex(i => i.value === served.value)
}

/** 滚动至底部，仅在用户当前已位于底部时执行 */
function scrollDown(): void {
  const el = box.value
  if (el === undefined) return
  // 阈值 40px：用户向上翻阅旧日志时不应被新日志强制拉回底部
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  if (atBottom) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
}

/** 拉取历史记录 */
async function loadHistory(): Promise<void> {
  try {
    const page = await get<LogPage>(`logs${queryString()}`)
    records.value = page.records
    file.value = page.file ?? ""
    error.value = ""
    scrollDown()
  } catch (err) {
    error.value = errorText(err)
  }
}

/** 关闭现有连接 */
function closeSocket(): void {
  if (socket === undefined) return
  // 先摘除 onclose 再 close：否则 close() 触发的回调会将 connected 置为 false，
  // 随后又被新建的连接改回，状态指示灯将出现一次闪烁
  socket.onclose = null
  socket.close()
  socket = undefined
  connected.value = false
}

/** 建立一条实时连接 */
function openLive(): void {
  closeSocket()
  if (!live.value) return
  const ws = openSocket(`logs${queryString()}`)
  socket = ws
  ws.onopen = () => (connected.value = true)
  ws.onclose = () => {
    connected.value = false
    // 不自动重连：内核停止运行时应明确显示"未连接"，静默重试会使用户误认为日志确实没有新内容
  }
  ws.onmessage = event => {
    try {
      const rec = JSON.parse(String(event.data)) as LogRecord
      // 原样入缓冲，不在此处按级别筛：筛选是显示层的事（见 `shown`）
      records.value = [...records.value.slice(-(MAX_LINES - 1)), rec]
      scrollDown()
    } catch {
      // 推送内容非 JSON 时只可能是中间层插入的数据，丢弃即可
    }
  }
}

/** 重新按当前条件加载 */
async function apply(): Promise<void> {
  await loadHistory()
  openLive()
}

watch(live, () => openLive())

// 勾选变化通常只收窄显示，无须惊动服务端。唯一的例外是放宽到比上次握手更低的级别 ——
// 此时服务端送来的已不是超集，缺的那几档只能重新取一遍
watch(picked, () => {
  if (outOfRange()) void apply()
})

// 首次有行渲染出来之后才量得到消息列宽：`ResizeObserver` 在 observe 时立刻回调一次，
// 而那一刻日志区还是空的，`.log-msg` 尚不存在
watch(
  () => shown.value.length,
  async count => {
    if (count > 0 && cols.value === 0) {
      await nextTick()
      measure()
    }
  }
)

/** 列宽随窗口变化，须重量 */
let sizer: ResizeObserver | undefined

onMounted(() => {
  void apply()
  sizer = new ResizeObserver(() => measure())
  if (box.value !== undefined) sizer.observe(box.value)
})

onUnmounted(() => {
  closeSocket()
  sizer?.disconnect()
  sizer = undefined
})
</script>

<template>
  <div>
    <PageHeader route="logs" sub="历史记录来自内存中的环形缓冲，实时记录来自 WebSocket">
      <template #meta>
        <span class="tag" :class="connected ? 'ok' : 'err'">{{ connected ? "已连接" : "未连接" }}</span>
      </template>
    </PageHeader>

    <p v-if="error" class="banner">{{ error }}</p>

    <div class="card log-filter">
      <!--
        级别筛选：可勾选药丸，按级别着色

        用原生复选框承载，故读屏播报与空格键切换都是白送的。药丸的颜色只复述文案
        已说明的事，不作唯一的信息载体。
      -->
      <div class="lvpick" role="group" aria-label="按级别筛选">
        <label v-for="lv in LEVELS" :key="lv.value" :class="['lvpill', lv.value]">
          <input type="checkbox" :checked="picked.includes(lv.value)" @change="toggleLevel(lv.value)" />
          <span>
            <b class="mono">{{ lv.value }}</b>
            {{ lv.label }}
          </span>
        </label>
      </div>

      <div class="row">
        <input v-model="scope" placeholder="作用域，如 kernel / plugin" style="width: 200px" />
        <input v-model="keyword" placeholder="关键字" style="width: 160px" @keyup.enter="void apply()" />
        <button class="primary" @click="void apply()">应用</button>
        <label class="check">
          <input v-model="live" type="checkbox" />
          <span class="checkmark"></span>
          实时推送
        </label>
      </div>
      <p v-if="file" class="hint mono">{{ file }}</p>
    </div>

    <div ref="box" class="logs mono">
      <!-- 量字符步进用的探针：字族字号由 `.logs` 继承而来，不在 JS 里另写一份字体常量 -->
      <span ref="probe" class="log-probe" aria-hidden="true">{{ PROBE_TEXT }}</span>

      <div v-for="(row, i) in rows" :key="`${row.rec.time}-${i}`" class="log">
        <span class="t">{{ clock(row.rec.time) }}</span>
        <span class="lv" :class="row.rec.level">{{ row.rec.level }}</span>
        <!--
          作用域超出列宽时由 CSS 省略，完整值放在 `title` 里 —— 该列定宽而文案由插件决定长度。
          行展开时一并展开（`open` 类改为折行），故「单击看全文」对这一列同样成立。
        -->
        <span class="sc" :class="{ open: row.open }" :title="row.rec.scope ?? ''">{{ row.rec.scope ?? "" }}</span>
        <!--
          截断的行做成按钮：点击展开，键盘同样可达。未截断的行仍是普通文本 ——
          给一个点了没有反应的按钮比不给更费解。

          两行上限画在内层的 span 上而非按钮自身：`<button>` 上的
          `display: -webkit-box` 会被规范化为 `flow-root`（实测如此），
          `-webkit-line-clamp` 在按钮上不生效，写在那里等于没有兜底。
        -->
        <button
          v-if="row.clipped"
          type="button"
          class="log-more"
          :aria-expanded="row.open"
          :title="row.open ? '收起' : '展开完整内容'"
          @click="toggle(row.rec)"
        >
          <span class="log-msg" :class="{ open: row.open }">{{ row.open ? row.full : row.brief }}</span>
        </button>
        <span v-else class="log-msg">{{ row.full }}</span>
      </div>

      <p v-if="rows.length === 0" class="hint">
        {{ records.length === 0 ? "没有匹配的日志" : `缓冲区内有 ${records.length} 条，但无一属于所选级别` }}
      </p>
    </div>
    <p class="hint">
      缓冲区最多保留 {{ MAX_LINES }} 行，当前
      {{ picked.length === 0 ? `${records.length} 条全部显示` : `显示 ${rows.length} / ${records.length} 条` }}。
      过长的记录截到两行并保留尾部两字，点击该行可展开。更早的记录可在日志文件中查阅。
    </p>
  </div>
</template>
