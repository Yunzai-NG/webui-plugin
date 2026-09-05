<script setup lang="ts">
/**
 * 模块职责：按 SchemaDescriptor 渲染单个字段行
 * 依赖方向：依赖 AppIcon 与类型
 * 生命周期：随父表单
 * 注意事项：**这里是整个面板中唯一决定控件形态的位置。** 标签、说明、取值范围与是否敏感全部来自
 *          `s.*` 声明推导出的描述结构体，故插件作者写完 configSchema 就自动有了表单。
 *
 *          `path` 以点号连接，与 `issues[].path` 一致 —— 由此 400 响应可逐字段标红，而不是只在顶部给
 *          一条汇总错误。
 *
 *          `showWhen` 在此处判断而非由父组件过滤：判断要用**同级**字段的当前值，而只有这一层知道
 *          同级字段的范围。
 *
 *          行形制是「左：图标 + 标签 + 说明；右：控件」。堆叠式一屏放不下五项，而配置页动辄二十余项。
 *          **图标由 widget 推导，不承载任何信息** —— 它只是长表单里的纵向锚点，故一律 `aria-hidden`，
 *          去掉它不丢失任何内容。
 *
 *          **多行控件不进右列**：多行文本与标签列表在 260px 宽里只能输入三四个字符，故整行铺开。
 *
 *          **下拉与分段回传枚举项的原值。** 原生 `<select>` 的 value 恒为字符串，直接回传会把数值项
 *          写成 `"3001"`、写入时校验失败，故按字符串形态反查候选项、回传其声明时的原值。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import AppIcon from "./AppIcon.vue"
import { CRON_FIELDS, explodeCron, joinCron, previewCron } from "../cron.js"
import { describePattern, lengthLimitOf, rangeTextOf } from "../field.js"
import { datetime } from "../format.js"
import { askPath } from "../pathpick.js"
import type { SchemaDescriptor, SchemaEnumItem } from "../types.js"

const props = defineProps<{
  /** 字段描述 */
  schema: SchemaDescriptor
  /** 字段当前值 */
  value: unknown
  /** 点号路径，如 `server.port` */
  path: string
  /** 同级字段的当前值，供 showWhen 判断 */
  siblings: Record<string, unknown>
  /** 本字段的校验错误 */
  error?: string
  /** 是否整体只读 */
  disabled?: boolean
  /**
   * 嵌套层级，0 为分区的直属字段
   *
   * 每层以左侧一道竖线加一段缩进表达。层级由父表单按路径算出而非在此推断：
   * 路径的首段是否算作一层取决于顶层字段是对象还是标量，这一点只有父表单知道。
   */
  indent?: number
}>()

const emit = defineEmits<{
  /** 值变化 */
  (e: "update", path: string, value: unknown): void
}>()

/**
 * 控件类型 → 图标
 *
 * 一律 24×24 网格上的 path 数据，语义与 `router.ts` 的 `RouteDef.icon` 相同。
 *
 * **刻意不标注为 `Record<string, string>`**：那样键退化为 `string`，在
 * `noUncheckedIndexedAccess` 之下取值成了 `string | undefined`，取图标处要多写一次
 * 恒不触发的兜底。不标注则键为字面量联合，`ICON_OF` 的值域由此约束。
 */
const ICONS = {
  /** 单行文本：竖排的 I 形光标 */
  text: "M9.5 5.5h5M12 5.5v13M9.5 18.5h5",
  /** 数值：井号 */
  number: "M9.5 4.5 8 19.5M16 4.5 14.5 19.5M4.5 9.5h15M4 14.5h15",
  /** 布尔：胶囊与滑块 */
  switch: "M8 8h8a4 4 0 0 1 0 8H8a4 4 0 0 1 0-8M14.8 12h.01",
  /** 枚举：候选列表与展开箭头 */
  select: "M4.5 8h9M4.5 12h9M4.5 16h5M16 10.5l2.5 2.5 2.5-2.5",
  /** 多值：标签 */
  tags: "M4.9 12.4 12.4 4.9a1.5 1.5 0 0 1 1-.4h4.7a1.5 1.5 0 0 1 1.5 1.5v4.7a1.5 1.5 0 0 1-.4 1l-7.5 7.5a1.5 1.5 0 0 1-2.1 0l-4.7-4.7a1.5 1.5 0 0 1 0-2.1M16.2 8h.01",
  /** 多行文本与代码：花括号 */
  code: "M9.5 5.5c-2 0-1 5.5-4 6.5 3 1 2 6.5 4 6.5M14.5 5.5c2 0 1 5.5 4 6.5-3 1-2 6.5-4 6.5",
  /** 敏感值：挂锁 */
  password: "M7.5 11V8.5a4.5 4.5 0 0 1 9 0V11M6.5 11h11v8h-11zM12 14.5v2",
  /** 路径：文件夹 */
  path: "M4 7.5A1.5 1.5 0 0 1 5.5 6h3l2 2.5h8A1.5 1.5 0 0 1 20 10v7.5A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z",
  /** 时长与 cron：钟面 */
  time: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16M12 8.2v4.1l2.9 1.8"
}

/** widget → 图标键 */
const ICON_OF: Record<string, keyof typeof ICONS> = {
  switch: "switch",
  select: "select",
  number: "number",
  slider: "number",
  password: "password",
  tags: "tags",
  multiselect: "tags",
  uid: "tags",
  keyValue: "tags",
  textarea: "code",
  code: "code",
  duration: "time",
  cron: "time",
  file: "path",
  dir: "path"
}

/**
 * 整行铺开的控件：在 260px 的右列里无法输入
 *
 * cron 也在其中：六段各需一个输入框，挤在 260px 里每格只剩三十来像素，
 * 而带步长的写法（星号、斜杠、两位数字）就有四个字符。
 */
const BLOCK_WIDGETS = new Set(["textarea", "code", "tags", "multiselect", "uid", "keyValue", "cron", "file", "dir"])

/**
 * 画成「药丸 + 加号」的自由数组控件
 *
 * `multiselect` 也在其中，但它只在**没有候选表**时走到这一路：有候选表时画的是那一排
 * 复选药丸（`mspick`），此处这一支是它的退路。
 */
const TAG_WIDGETS = new Set(["tags", "multiselect", "uid"])

/** 时长单位；顺序即下拉中的顺序 */
const DUR_UNITS: readonly { value: string; label: string }[] = [
  { value: "ms", label: "毫秒" },
  { value: "s", label: "秒" },
  { value: "m", label: "分" },
  { value: "h", label: "时" },
  { value: "d", label: "天" }
]

const DUR_RE = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d)$/

/** 标签文案：没写 title 就退回字段名，绝不显示空标签 */
const label = computed(() => props.schema.title ?? props.path.split(".").pop() ?? props.path)

/** 该显示吗 */
const visible = computed(() => {
  const cond = props.schema.showWhen
  if (cond === undefined) return true
  // 期望值写成数组表示"取其中之一"。适配器的连接地址要在正向 WS 与两种 HTTP 模式下
  // 都出现、只在反向 WS 下隐藏，没有这条规则就只能把同一个字段复制三份
  return Object.entries(cond).every(([key, expected]) =>
    Array.isArray(expected) ? expected.includes(props.siblings[key]) : props.siblings[key] === expected
  )
})

/** 实际用哪种控件：widget 优先，其次按 type 推断 */
const widget = computed(() => {
  const s = props.schema
  if (s.widget !== undefined) return s.widget
  if (s.type === "boolean") return "switch"
  if (s.type === "number") return "number"
  if (s.type === "enum") return "select"
  if (s.type === "array") return "tags"
  return "text"
})

/** 本行的图标 */
const icon = computed(() => ICONS[ICON_OF[widget.value] ?? "text"])

/** 控件是否整行铺开 */
const block = computed(() => BLOCK_WIDGETS.has(widget.value))

/** 该字段是否不可编辑 */
const locked = computed(() => props.disabled === true || props.schema.readonly === true)

/**
 * 缩进层级交给 CSS 变量，缩进量与竖线位置由样式表决定
 *
 * 不在此处算像素：缩进量属间距刻度，写死在组件里会绕过 `--s*` 那套刻度，
 * 日后调整刻度时这一处不会跟着变。
 */
const indentStyle = computed(() => ({ "--indent": String(props.indent ?? 0) }))

/** 枚举候选 */
const options = computed<readonly SchemaEnumItem[]>(() => props.schema.enum ?? [])

/**
 * 枚举是否改用分段单选
 *
 * 候选不超过四項、且每項文案不超過六字時才分段：候選一多分段就窄到讀不出文案，
 * 「內嵌 LevelDB」一類的長文案在 260px 裡並排四項每項只剩十幾像素。其餘情形用下拉。
 */
const segmented = computed(
  () =>
    widget.value === "select" &&
    options.value.length > 1 &&
    options.value.length <= 4 &&
    options.value.every(item => (item.label ?? String(item.value)).length <= 6)
)

/** 分段單選由 role=radiogroup 承載標籤，故標籤不能是 label 元素 */
const labelId = computed(() => `${props.path}__label`)

/* ─────────────── 自定義下拉組件 ─────────────── */

/** 下拉菜單是否展開 */
const dropdownOpen = ref(false)

/** 當前懸停的選項索引，用於鍵盤導航高亮 */
const dropdownHoverIndex = ref(-1)

/** 下拉觸發器元素，供定位與焦點管理使用 */
const dropdownTriggerRef = ref<HTMLButtonElement | undefined>(undefined)

/** 下拉菜單元素，供判斷點擊是否在菜單內 */
const dropdownMenuRef = ref<HTMLDivElement | undefined>(undefined)

/** 下拉菜單是否向上翻轉（底部空間不足時） */
const dropdownFlipUp = ref(false)

/**
 * 切換下拉菜單的展開狀態
 *
 * 展開時將當前選中項置為懸停索引，失焦時重置。
 * 展開時檢測底部空間，不足且頂部有足夠空間時向上翻轉。
 */
function toggleDropdown(): void {
  if (locked.value) return
  dropdownOpen.value = !dropdownOpen.value
  if (dropdownOpen.value) {
    // 展開時定位到當前選中項
    const currentIndex = options.value.findIndex(item => String(item.value) === String(props.value))
    dropdownHoverIndex.value = currentIndex >= 0 ? currentIndex : 0
    void nextTick(() => {
      if (dropdownTriggerRef.value && dropdownMenuRef.value) {
        const triggerRect = dropdownTriggerRef.value.getBoundingClientRect()
        const spaceBelow = window.innerHeight - triggerRect.bottom
        const menuHeight = dropdownMenuRef.value.offsetHeight
        dropdownFlipUp.value = spaceBelow < menuHeight && triggerRect.top > menuHeight
      }
      dropdownMenuRef.value?.focus()
    })
  } else {
    dropdownHoverIndex.value = -1
    dropdownFlipUp.value = false
  }
}

/** 關閉下拉菜單 */
function closeDropdown(): void {
  dropdownOpen.value = false
  dropdownHoverIndex.value = -1
}

/** 選中某個選項 */
function selectDropdownItem(item: SchemaEnumItem): void {
  setEnum(String(item.value))
  closeDropdown()
  // 將焦點返回給觸發器，保持鍵盤可操作性
  void nextTick(() => dropdownTriggerRef.value?.focus())
}

/** 下拉菜單的鍵盤導航 */
function handleDropdownKeydown(event: KeyboardEvent): void {
  if (!dropdownOpen.value) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      toggleDropdown()
    }
    return
  }

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault()
      dropdownHoverIndex.value = (dropdownHoverIndex.value + 1) % options.value.length
      break
    case "ArrowUp":
      event.preventDefault()
      dropdownHoverIndex.value = (dropdownHoverIndex.value - 1 + options.value.length) % options.value.length
      break
    case "Enter":
    case " ":
      event.preventDefault()
      if (dropdownHoverIndex.value >= 0 && dropdownHoverIndex.value < options.value.length) {
        const item = options.value[dropdownHoverIndex.value]
        if (item) selectDropdownItem(item)
      }
      break
    case "Escape":
      event.preventDefault()
      closeDropdown()
      void nextTick(() => dropdownTriggerRef.value?.focus())
      break
    case "Home":
      event.preventDefault()
      dropdownHoverIndex.value = 0
      break
    case "End":
      event.preventDefault()
      dropdownHoverIndex.value = options.value.length - 1
      break
  }
}

/** 點擊外部關閉下拉菜單 */
function handleOutsideClick(event: MouseEvent): void {
  if (!dropdownOpen.value) return
  const target = event.target as Node
  if (
    dropdownTriggerRef.value?.contains(target) ||
    dropdownMenuRef.value?.contains(target)
  ) {
    return
  }
  closeDropdown()
}

onMounted(() => {
  document.addEventListener("click", handleOutsideClick, true)
})

onBeforeUnmount(() => {
  document.removeEventListener("click", handleOutsideClick, true)
})

/** 数组类控件的各项，一项一枚药丸 */
const listItems = computed(() => (Array.isArray(props.value) ? props.value.map(v => String(v)) : []))

/* ─────────────── 自由数组：药丸 + 加号 ─────────────── */

/** 加号是否已展开成输入框 */
const adding = ref(false)

/** 正在输入的那一项；回车之后才成为数组的一项 */
const draft = ref("")

/** 输入框本身，供展开后立刻取得焦点 */
const addBox = ref<HTMLInputElement | undefined>(undefined)

/**
 * 展开输入框并把焦点放进去
 *
 * 焦点这一手是必须的：点了加号却还要再点一次输入框才能打字，那个加号就只是个装饰。
 * `nextTick` 之后元素才在文档里，此前 `focus()` 无处可落。
 */
function beginAdd(): void {
  adding.value = true
  draft.value = ""
  void nextTick(() => addBox.value?.focus())
}

/** 收起输入框，丢掉正在输入的内容 */
function cancelAdd(): void {
  adding.value = false
  draft.value = ""
}

/**
 * 把正在输入的那一项收进数组
 *
 * **空白与重复一律不收**，且都只是静默收起 —— 这两种情形下使用者的意图明显是「算了」，
 * 为此弹一句错误反而要他再点一次关掉。
 *
 * 回车之后**不收起输入框**：连着添几项是常态（三个命令前缀就是三次），每次都要重点一下
 * 加号等于把一次操作拆成三次。失焦那一路才收起。
 */
function commitAdd(): void {
  const text = draft.value.trim()
  if (text === "") return cancelAdd()
  if (listItems.value.includes(text)) {
    draft.value = ""
    return
  }
  set([...listItems.value, text])
  draft.value = ""
  void nextTick(() => addBox.value?.focus())
}

/**
 * 移除第 n 项
 *
 * 按**序号**而非按值：数组里允许有重复项（配置文件里就可能有），按值删会一次删掉两枚，
 * 而使用者点的是其中一枚。
 * @param index 项的序号
 */
function dropItem(index: number): void {
  set(listItems.value.filter((_, i) => i !== index))
}

/* ─────────────── 约束提示：取值范围 / 正则 / 字数计数 ─────────────── */

/**
 * 约束说明的静态部分
 *
 * 与计数器同放在左列的标签之下，而不是控件旁边：右列只有 260px，且 `block` 类
 * 控件的控件本身已横跨整行 —— 两种布局下都存在的位置只有左列。
 */
const rangeHint = computed(() => rangeTextOf(props.schema))

/**
 * 正则的人话说明
 *
 * 认不出的正则原样示出并注明是正则，不硬翻 —— 理由见 `field.ts` 的文件头。
 */
const patternHint = computed(() => {
  const source = props.schema.pattern
  if (source === undefined || source === "") return undefined
  return describePattern(source) ?? `需匹配正则 ${source}`
})

/** 字数或项数计数，随输入实时变化 */
const limit = computed(() => lengthLimitOf(props.schema, props.value))

/* ─────────────── 多选 ─────────────── */

/**
 * 多选的候选项
 *
 * 取 `items.enum`：多选字段的形态是「元素为枚举的数组」（`s.array(s.enumOf([…]))`），
 * 候选表因此挂在元素描述上。同时兼容直接写在本级的 `enum`，那是把枚举字段标成
 * multiselect 的写法。
 */
const multiOptions = computed<readonly SchemaEnumItem[]>(() => props.schema.items?.enum ?? props.schema.enum ?? [])

/** 当前已选（原值数组） */
const picked = computed<readonly unknown[]>(() => (Array.isArray(props.value) ? props.value : []))

/**
 * 候选表之外的既有取值
 *
 * **必须留着。** 插件改版删掉某个候选项后，配置文件里那一项仍在；只按候选表重建数组
 * 会让使用者一存就把它悄悄删了。故单列出来标明「不在候选中」，由使用者决定去留。
 */
const extras = computed(() => {
  const known = new Set(multiOptions.value.map(item => String(item.value)))
  return picked.value.filter(v => !known.has(String(v)))
})

/**
 * 某个候选是否已选中
 * @param item 候选项
 * @returns 是否选中
 */
function isPicked(item: SchemaEnumItem): boolean {
  return picked.value.some(v => String(v) === String(item.value))
}

/**
 * 标签是否改由 `<span>` + `aria-labelledby` 承载
 *
 * 一个 `<label for>` 必须指向确实存在的那一个控件。多选与键值对都是**一组**控件，
 * 组里没有哪一个配得上「这就是本字段」——多选指向首个复选框会把整个字段的标签
 * 读成第一个候选项的名字。此时改用 `role=group` 加 `aria-labelledby`。
 */
const grouped = computed(
  () =>
    segmented.value ||
    (widget.value === "multiselect" && multiOptions.value.length > 0) ||
    widget.value === "keyValue" ||
    // 自由数组同理：一组药丸加一个加号，没有哪一个配得上「这就是本字段」。
    // 加号那个输入框更不行 —— 它平时根本不在文档里
    TAG_WIDGETS.has(widget.value)
)

/**
 * 勾选或取消一个候选
 *
 * 重建后的数组按**候选表的顺序**排列，而非点击顺序：同一份选择在文件里应当只有
 * 一种写法，否则每次改动都在 yaml 里留下一片无意义的顺序变更。候选表之外的取值
 * 追加在末尾，保持原有相对顺序。
 * @param item 候选项
 */
function togglePick(item: SchemaEnumItem): void {
  const on = isPicked(item)
  const keep = new Set(picked.value.map(v => String(v)))
  if (on) keep.delete(String(item.value))
  else keep.add(String(item.value))
  const ordered = multiOptions.value.filter(opt => keep.has(String(opt.value))).map(opt => opt.value)
  set([...ordered, ...extras.value.filter(v => keep.has(String(v)))])
}

/**
 * 移除一个候选表之外的取值
 * @param value 要移除的取值
 */
function dropExtra(value: unknown): void {
  set(picked.value.filter(v => String(v) !== String(value)))
}

/* ─────────────── 滑杆 ─────────────── */

/**
 * 是否真能画成滑杆
 *
 * 两端都要有界。缺一端的 `range` 控件会被浏览器按默认的 0–100 处理 —— 一个上限为
 * 3600 的字段拖到底只有 100，看不出任何异常，而值是错的。此时退回数值输入框。
 */
const slidable = computed(
  () => widget.value === "slider" && props.schema.min !== undefined && props.schema.max !== undefined
)

/** 滑杆当前值：读不出数值时取下界，不留空 —— range 控件没有「空」这个状态 */
const sliderValue = computed(() => {
  const value = props.value
  if (typeof value === "number" && Number.isFinite(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : (props.schema.min ?? 0)
})

/**
 * 时长的「数值 + 单位」拆解
 *
 * 读不懂的写法一律返回 undefined，由模板退回纯文本框 —— 复合控件无法表达
 * `"1h30m"` 一类内核也不接受但确实可能出现在文件里的值，若强行按 0 呈现，
 * 使用者一保存就把原值抹掉了。
 */
const dur = computed<{ n: number; unit: string } | undefined>(() => {
  const value = props.value
  if (typeof value === "number" && Number.isFinite(value)) return { n: value, unit: "ms" }
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (/^-?\d+$/.test(text)) return { n: Number(text), unit: "ms" }
  const matched = DUR_RE.exec(text)
  return matched === null ? undefined : { n: Number(matched[1]), unit: matched[2] as string }
})

/* ─────────────── cron ─────────────── */

/** 六段的当前内容；由当前值摊开而来 */
const cronParts = computed(() => explodeCron(String(props.value ?? "")))

/**
 * 下次触发预览
 *
 * 起算时刻取求值当时的 `Date.now()`，不做逐秒刷新：这是一份「按现在算，接下来是这几次」
 * 的说明，而非一个倒计时。逐秒重算要为每个 cron 字段挂一个定时器，而配置页上
 * 通常只有一两个这样的字段，代价与收益不成比例。
 */
const cronPreview = computed(() => previewCron(joinCron(cronParts.value), Date.now(), 3))

/** 预览文本 */
const cronTimes = computed(() => cronPreview.value.times.map(time => datetime(time)))

/**
 * 改动某一段
 * @param index 段序号，0 为秒
 * @param text 新内容
 */
function setCronPart(index: number, text: string): void {
  const next = [...cronParts.value]
  next[index] = text
  set(joinCron(next))
}

/* ─────────────── 键值对 ─────────────── */

/** 一行键值 */
interface KvRow {
  /** 键 */
  key: string
  /** 值的文本形态 */
  text: string
}

/**
 * 键值对的行状态
 *
 * **必须自持行状态，不能直接从 props 派生。** 新增一行时键还是空的，而空键无法落进
 * 对象；改名的过程中也会短暂出现重键。若每次按键都从对象反推行，光标会在重建时
 * 跳走、空行会立刻消失。故此处保留行数组，仅在「键非空」时把它折成对象提交。
 */
const kvRows = ref<KvRow[]>([])

/** 最近一次提交出去的对象的序列化形态，用于判断 props 的变化是否来自本组件 */
let kvSent = ""

/**
 * 值的文本形态 → 按声明的类型还原
 *
 * 还原不了的原样留作字符串：交给服务端校验并回报具体字段，比在前端悄悄改成 0 好 ——
 * 后者会让使用者以为自己输入的内容被接受了。
 * @param text 文本
 * @returns 还原后的值
 */
function kvValueOf(text: string): unknown {
  const type = props.schema.values?.type
  if (type === "number") {
    const n = Number(text)
    return text.trim() !== "" && Number.isFinite(n) ? n : text
  }
  if (type === "boolean") {
    const lower = text.trim().toLowerCase()
    if (lower === "true" || lower === "是") return true
    if (lower === "false" || lower === "否") return false
    return text
  }
  return text
}

/** 把行数组折成对象并提交；空键的行忽略，重键以最后一行为准 */
function kvCommit(): void {
  const out: Record<string, unknown> = {}
  for (const row of kvRows.value) {
    const key = row.key.trim()
    if (key === "") continue
    out[key] = kvValueOf(row.text)
  }
  kvSent = JSON.stringify(out)
  set(out)
}

/** 由当前值重建行数组 */
function kvSync(): void {
  if (widget.value !== "keyValue") return
  const value = props.value
  const obj =
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  // 本组件刚提交的那一份不必重建：重建会把正在输入的空行抹掉
  if (JSON.stringify(obj) === kvSent) return
  kvSent = JSON.stringify(obj)
  kvRows.value = Object.entries(obj).map(([key, v]) => ({ key, text: v === null || v === undefined ? "" : String(v) }))
}

watch(() => props.value, kvSync, { immediate: true })

/** 重复的键：以行序号标出，供界面标红 */
const kvDuplicated = computed(() => {
  const seen = new Map<string, number>()
  const out = new Set<number>()
  kvRows.value.forEach((row, index) => {
    const key = row.key.trim()
    if (key === "") return
    const first = seen.get(key)
    if (first === undefined) seen.set(key, index)
    else {
      out.add(first)
      out.add(index)
    }
  })
  return out
})

/** 添加一行 */
function kvAdd(): void {
  kvRows.value = [...kvRows.value, { key: "", text: "" }]
}

/**
 * 删除一行
 * @param index 行序号
 */
function kvRemove(index: number): void {
  kvRows.value = kvRows.value.filter((_, i) => i !== index)
  kvCommit()
}

/**
 * 改一行的键或值
 * @param index 行序号
 * @param patch 要改的部分
 */
function kvEdit(index: number, patch: Partial<KvRow>): void {
  kvRows.value = kvRows.value.map((row, i) => (i === index ? { ...row, ...patch } : row))
  kvCommit()
}

/**
 * 提交一个新值
 * @param next 新值
 */
function set(next: unknown): void {
  emit("update", props.path, next)
}

/* ─────────────── 路径 ─────────────── */

/**
 * 打开目录选择器
 *
 * **手敲输入框一并保留，不以此取代**：列目录接口在只读模式下停用，那时这个按钮
 * 点开只有 403，而配置项仍须可填。
 *
 * 只把字段当前值原样交出去，不预先算起始目录 —— 那取决于选的是目录还是文件
 * （选文件时要列它所在的目录），而选择器自己知道 mode，两边各算一遍迟早不一样。
 */
async function pickPath(): Promise<void> {
  const current = String(props.value ?? "").trim()
  const mode = widget.value === "dir" ? "dir" : "file"
  const picked = await askPath({ title: label.value, mode, ...(current === "" ? {} : { start: current }) })
  if (picked !== undefined) set(picked)
}

/**
 * 由下拉或分段的字符串形态回传枚举项的原值
 * @param raw 控件给出的字符串
 */
function setEnum(raw: string): void {
  const found = options.value.find(item => String(item.value) === raw)
  set(found === undefined ? raw : found.value)
}

/**
 * 从多行文本还原数组
 *
 * 空行一律丢弃：用户在末尾多输入一个回车不应产生一个空字符串项 ——
 * 那会让 `bot.prefix` 里出现一个"空前缀"，效果是所有消息都匹配。
 * @param text 文本
 */
function setList(text: string): void {
  set(
    text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line !== "")
  )
}

/**
 * 从输入框还原数字
 *
 * 空串还原成 undefined 而不是 0：可选数值字段被清空的意思是"不设置"，
 * 而 0 往往是一个合法但完全不同的取值（比如超时 0 = 不超时）。
 * @param text 文本
 */
function setNumber(text: string): void {
  if (text.trim() === "") return set(undefined)
  const n = Number(text)
  set(Number.isNaN(n) ? text : n)
}

/**
 * 提交时长
 *
 * 单位为毫秒时回传数值而非 `"5ms"`：内核的 `duration()` 两种写法都收，而原本写作
 * `cooldown: 0` 的项若被改写成 `"0ms"`，看起来像框架在乱改文件。
 *
 * 改单位时数值原样保留，不做等值换算：`5000` 毫秒换成秒该得 `5` 还是 `5000` 取决于
 * 使用者的意图，替其决定必有一半场合是错的，且错得静默。
 * @param text 数值输入框的内容
 * @param unit 单位
 */
function setDuration(text: string, unit: string): void {
  if (text.trim() === "") return
  const n = Number(text)
  if (!Number.isFinite(n)) return
  set(unit === "ms" ? n : `${n}${unit}`)
}
</script>

<template>
  <div v-if="visible" class="srow" :class="{ bad: error !== undefined, block, nested: (indent ?? 0) > 0 }" :style="indentStyle">
    <span class="s-icon"><AppIcon :path="icon" /></span>

    <div class="s-text">
      <span v-if="grouped" :id="labelId" class="s-label">
        {{ label }}
        <span v-if="schema.required === true" class="tag warn">必填</span>
        <span v-if="schema.readonly === true" class="tag">只读</span>
      </span>
      <label v-else :for="path" class="s-label">
        {{ label }}
        <span v-if="schema.required === true" class="tag warn">必填</span>
        <span v-if="schema.readonly === true" class="tag">只读</span>
      </label>
      <p v-if="schema.description" class="hint">{{ schema.description }}</p>
      <!--
        约束一行：取值范围、正则说明与实时计数

        三者同处一行且以「·」相隔，不各占一行 —— 一个字段之下堆三行灰字，比字段本身
        还高。计数超出上限时整行转为错误色：此时保存必定失败，早一步说出来。
      -->
      <p v-if="rangeHint || patternHint || limit" class="s-limits" :class="{ over: limit?.over }">
        <span v-if="rangeHint">{{ rangeHint }}</span>
        <span v-if="patternHint">{{ patternHint }}</span>
        <span v-if="limit">{{ limit.used }} / {{ limit.max }} {{ limit.unit }}</span>
      </p>
      <p v-if="error !== undefined" class="err">{{ error }}</p>
    </div>

    <div class="s-ctl">
      <!-- 布尔：仍是原生复选框，只把外观换成开关 —— 空格键切换与读屏播报都是白送的 -->
      <label v-if="widget === 'switch'" class="switch">
        <input
          :id="path"
          type="checkbox"
          :checked="value === true"
          :disabled="locked"
          @change="set(($event.target as HTMLInputElement).checked)"
        />
        <span class="switch-track"></span>
      </label>

      <!-- 分段单选：用原生 radio，方向键在组内移动也是白送的 -->
      <div v-else-if="segmented" class="seg" role="radiogroup" :aria-labelledby="labelId">
        <label v-for="item in options" :key="String(item.value)" :title="item.description">
          <input
            type="radio"
            :name="path"
            :checked="String(item.value) === String(value)"
            :disabled="locked"
            @change="setEnum(String(item.value))"
          />
          <span>{{ item.label ?? String(item.value) }}</span>
        </label>
      </div>

      <!--
        自定义下拉：替代原生 <select>

        原生 <select> 的选项背景色由操作系统渲染，无法通过 CSS 控制——悬停/选中一律是深灰色，
        与玻璃拟态 UI 冲突。此处用 button + div 模拟下拉列表，完全控制样式。
        键盘导航（上下箭头、Enter、Escape）与无障碍属性（role/aria）均保留。
      -->
      <div
        v-else-if="widget === 'select'"
        class="cdd"
        :class="{ open: dropdownOpen, locked: locked, 'flip-up': dropdownFlipUp }"
      >
        <button
          ref="dropdownTriggerRef"
          type="button"
          :id="path"
          :disabled="locked"
          :aria-expanded="dropdownOpen"
          :aria-controls="`${path}__menu`"
          :aria-labelledby="labelId"
          class="cdd-trigger"
          @click="toggleDropdown()"
          @keydown="handleDropdownKeydown"
        >
          <span class="cdd-value">{{ options.find(item => String(item.value) === String(value))?.label ?? String(value ?? '') }}</span>
          <svg class="cdd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <Transition name="cdd-fx">
          <div
            v-if="dropdownOpen"
            ref="dropdownMenuRef"
            :id="`${path}__menu`"
            class="cdd-menu"
            role="listbox"
            tabindex="-1"
            @keydown="handleDropdownKeydown"
          >
            <button
              v-for="(item, idx) in options"
              :key="String(item.value)"
              type="button"
              role="option"
              :aria-selected="String(item.value) === String(value) ? 'true' : 'false'"
              :class="{ active: String(item.value) === String(value), hover: idx === dropdownHoverIndex }"
              :title="item.description"
              @click="selectDropdownItem(item)"
              @mouseenter="dropdownHoverIndex = idx"
              @mouseleave="dropdownHoverIndex = -1"
            >
              {{ item.label ?? String(item.value) }}
            </button>
          </div>
        </Transition>
      </div>

      <!-- 时长：数值与单位分开，使用者不必记住 "30s" 这种写法 -->
      <div v-else-if="widget === 'duration' && dur !== undefined" class="dur">
        <input
          :id="path"
          type="number"
          :value="dur.n"
          :disabled="locked"
          @input="setDuration(($event.target as HTMLInputElement).value, dur.unit)"
        />
        <select :aria-label="`${label}的单位`" :disabled="locked" @change="setDuration(String(dur.n), ($event.target as HTMLSelectElement).value)">
          <option v-for="unit in DUR_UNITS" :key="unit.value" :value="unit.value" :selected="unit.value === dur.unit">
            {{ unit.label }}
          </option>
        </select>
      </div>

      <input
        v-else-if="widget === 'number' || (widget === 'slider' && !slidable)"
        :id="path"
        type="number"
        :value="value ?? ''"
        :min="schema.min"
        :max="schema.max"
        :step="schema.step"
        :placeholder="schema.placeholder"
        :disabled="locked"
        @input="setNumber(($event.target as HTMLInputElement).value)"
      />

      <!-- 滑杆：数值同时以文本示出 —— 只拖不看数是调不准的 -->
      <div v-else-if="widget === 'slider'" class="slider">
        <input
          :id="path"
          type="range"
          :value="sliderValue"
          :min="schema.min"
          :max="schema.max"
          :step="schema.step ?? 1"
          :disabled="locked"
          @input="setNumber(($event.target as HTMLInputElement).value)"
        />
        <output class="slider-out">{{ sliderValue }}</output>
      </div>

      <!-- 敏感字段使用 password 控件，但取回的值为明文（见 api.ts 的说明）：
           由此查看当前令牌只需点击浏览器的显示按钮，无须查阅 yaml 文件 -->
      <input
        v-else-if="widget === 'password'"
        :id="path"
        type="password"
        autocomplete="off"
        :value="value ?? ''"
        :placeholder="schema.placeholder"
        :disabled="locked"
        @input="set(($event.target as HTMLInputElement).value)"
      />

      <!--
        多选：复选框药丸组

        控件仍是原生复选框（透明压在药丸上），空格键切换与读屏播报都是白送的。
        候选表为空时落回「一行一项」的文本域 —— 那时无从画出候选，字段仍须可编辑。
      -->
      <div
        v-else-if="widget === 'multiselect' && multiOptions.length > 0"
        class="mspick"
        role="group"
        :aria-labelledby="labelId"
      >
        <label v-for="item in multiOptions" :key="String(item.value)" class="mspill" :title="item.description">
          <input type="checkbox" :checked="isPicked(item)" :disabled="locked" @change="togglePick(item)" />
          <span>{{ item.label ?? String(item.value) }}</span>
        </label>
        <!--
          候选表之外的既有取值：标出来由使用者决定去留，不静默丢弃

          离场带淡出，且**不脱离文档流**（键值对那边是脱的）：药丸是随内容宽的行内块，
          脱流后会跳到容器左上角压在第一枚上。代价是补位那一下是瞬时的。
        -->
        <TransitionGroup name="pillfx">
          <span v-for="extra in extras" :key="`x-${String(extra)}`" class="mspill extra">
            <span>
              {{ String(extra) }}
              <button v-if="!locked" type="button" :aria-label="`移除 ${String(extra)}`" @click="dropExtra(extra)">
                ×
              </button>
            </span>
          </span>
        </TransitionGroup>
      </div>

      <!--
        cron：六段分开填，并给出接下来的三次触发时刻

        预览是这个控件存在的理由 —— 表达式本身写对写错都不报错，只是到点不响。
        推算不出时如实说明原因，不留一片空白（见 cron.ts 的文件头）。
      -->
      <div v-else-if="widget === 'cron'" class="cron">
        <div class="cron-parts">
          <label v-for="(field, i) in CRON_FIELDS" :key="field.label" class="cron-part">
            <span class="cron-cap">{{ field.label }}</span>
            <input
              :id="i === 0 ? path : undefined"
              type="text"
              inputmode="text"
              :value="cronParts[i] ?? ''"
              :placeholder="field.optional === true ? '留空' : '*'"
              :title="`允许 ${field.range}`"
              :disabled="locked"
              @input="setCronPart(i, ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
        <p v-if="cronPreview.ok" class="cron-next">接下来：{{ cronTimes.join("、") }}（本机时区）</p>
        <p v-else class="cron-next bad">{{ cronPreview.reason }}</p>
      </div>

      <!--
        键值对：一行一对，键可改名

        删除一行在配置页需由页面另行处置 —— `PATCH` 是深合并，删掉的键在服务端仍然
        存在。见 ConfigView.vue 中对此的说明与做法。
      -->
      <div v-else-if="widget === 'keyValue'" class="kv" role="group" :aria-labelledby="labelId">
        <!--
          增删带过渡。key 取行号：删中间一行会使其后各行的 key 全部前移一位，
          于是那些行走 FLIP（`rowfx-move`）而非离场，观感上恰是「余下的补位上来」。
        -->
        <TransitionGroup name="rowfx">
          <div v-for="(row, i) in kvRows" :key="i" class="kv-row" :class="{ bad: kvDuplicated.has(i) }">
            <input
              type="text"
              :value="row.key"
              :aria-label="`第 ${i + 1} 项的键`"
              placeholder="键"
              :disabled="locked"
              @input="kvEdit(i, { key: ($event.target as HTMLInputElement).value })"
            />
            <input
              type="text"
              :value="row.text"
              :aria-label="`第 ${i + 1} 项的值`"
              placeholder="值"
              :disabled="locked"
              @input="kvEdit(i, { text: ($event.target as HTMLInputElement).value })"
            />
            <button type="button" :disabled="locked" :aria-label="`删除第 ${i + 1} 项`" @click="kvRemove(i)">删除</button>
          </div>
        </TransitionGroup>
        <p v-if="kvDuplicated.size > 0" class="err">键重复，重复者只有最后一行会被保存</p>
        <button type="button" :disabled="locked" @click="kvAdd()">添加一项</button>
      </div>

      <!--
        路径：文本框 + 浏览按钮

        文本框不是退路而是**主路**：只读模式下列目录接口停用，浏览按钮点开只会得到 403，
        而字段仍须可填；粘贴一条已知路径也远比逐层点开快。
      -->
      <div v-else-if="widget === 'file' || widget === 'dir'" class="pathpick">
        <input
          :id="path"
          type="text"
          :value="String(value ?? '')"
          :placeholder="schema.placeholder ?? (widget === 'dir' ? '服务器上的目录，如 /home/yunzai/data' : '服务器上的文件路径')"
          :disabled="locked"
          @input="set(($event.target as HTMLInputElement).value)"
        />
        <button type="button" :disabled="locked" @click="void pickPath()">浏览…</button>
      </div>

      <!--
        自由数组：一项一枚药丸，加号展开一个输入框，回车添加

        原先是「一行一项」的文本域。那种写法把三个前缀显示成一个三行高的框，且**每敲一个
        字符就重建整个数组** —— 中间那一行还没输完就已经作为一项存在了。药丸则是「已成立的
        项」与「正在输入的项」分开：输入框里的东西回车之后才成为一项。
      -->
      <div v-else-if="widget === 'tags' || widget === 'multiselect' || widget === 'uid'" class="taglist" role="group" :aria-labelledby="labelId">
        <TransitionGroup name="pillfx">
          <span v-for="(item, i) in listItems" :key="`${i}:${item}`" class="tagpill">
            <span>{{ item }}</span>
            <button v-if="!locked" type="button" :aria-label="`移除 ${item}`" @click="dropItem(i)">×</button>
          </span>
        </TransitionGroup>

        <!--
          加号与输入框是同一处的两态，不是并列的两件东西

          并列摆着的话，一个空数组下面会一直吊着一个空输入框 —— 而多数字段一辈子不会被改。
          点加号才展开，`ref` 里那一手把焦点直接放进去，故点完即可开始打字。
        -->
        <button v-if="!locked && !adding" type="button" class="tagadd" @click="beginAdd()">＋ 添加</button>
        <input
          v-if="adding"
          ref="addBox"
          class="tagbox"
          type="text"
          :value="draft"
          :placeholder="schema.placeholder ?? '回车添加，Esc 取消'"
          :aria-label="`新增一项到${label}`"
          :disabled="locked"
          @input="draft = ($event.target as HTMLInputElement).value"
          @keydown.enter.prevent="commitAdd()"
          @keydown.esc.prevent="cancelAdd()"
          @blur="commitAdd()"
        />
      </div>

      <textarea
        v-else-if="widget === 'textarea' || widget === 'code'"
        :id="path"
        :value="String(value ?? '')"
        :placeholder="schema.placeholder"
        :disabled="locked"
        @input="set(($event.target as HTMLTextAreaElement).value)"
      ></textarea>

      <input
        v-else
        :id="path"
        type="text"
        :value="String(value ?? '')"
        :placeholder="schema.placeholder"
        :disabled="locked"
        @input="set(($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>
