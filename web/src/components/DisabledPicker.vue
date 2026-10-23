<script setup lang="ts">
/**
 * 模块职责：挑「禁用哪些插件或命令」—— 目录插件、单文件 JS、已禁用三个页签，每个插件一格，多列排开
 * 依赖方向：依赖 disabledgrid / collapse / outside 与类型
 * 生命周期：随所在表单
 * 注意事项：**格子而非一行一个**：装上二三十个单文件 JS 时，一行一个要翻好几屏；收起时只露三行，
 *          要看全部点「展开全部」，筛选与「已禁用」不受这个限制。
 *
 *          格子上的勾选框禁整个插件，并清掉它已有的单条命令；点格子在**它那一行下面**展开详情，
 *          命令是一枚枚小胶囊，+ 加 × 删。详情紧跟所在行，免得点了第一行去最底下找。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue"
import { onExpandDone, onExpandEnter, onExpandLeave, pinLeaving, swapHeightHooks, tweenHeight } from "../collapse.js"
import { buildTiles, detailAfter, staleOf, tilesOf, touched, visibleCount, type DisabledTab, type DisabledTile } from "../disabledgrid.js"
import { onClickOutside } from "../outside.js"
import type { CommandItem } from "../types.js"

const props = defineProps<{
  /** 当前禁用项：插件名或 `插件名:命令名` */
  modelValue: readonly string[]
  /** 全部命令 */
  commands: readonly CommandItem[]
  /** 注册了命令的目录插件名 */
  plugins: readonly string[]
  /** 注册了命令的单文件 JS 名 */
  scripts?: readonly string[]
}>()

const emit = defineEmits<{
  /** 改了 */
  "update:modelValue": [value: string[]]
}>()

/** 收起时露几行 */
const ROWS = 3
/** 格子多于这些才给筛选框 */
const SEARCH_AT = 8

const uid = useId()
const root = ref<HTMLElement>()
const grid = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const tab = ref<DisabledTab>("plugins")
const query = ref("")
/** 展开着详情的那一格 */
const expanded = ref("")
const showAll = ref(false)
const cols = ref(1)
/** 详情换内容、页签换内容各用一份：两处的外框不是同一个 */
const swap = swapHeightHooks()
const stageSwap = swapHeightHooks()

onClickOutside(root, () => (expanded.value = ""), () => expanded.value !== "")
const tiles = computed(() => buildTiles(props.plugins, props.scripts ?? [], props.commands, props.modelValue))
const stale = computed(() => staleOf(props.modelValue, tiles.value))
const counts = computed(() => ({
  plugins: tiles.value.filter(t => !t.script).length,
  scripts: tiles.value.filter(t => t.script).length,
  disabled: tiles.value.filter(touched).length
}))
const tabs = computed(() =>
  [
    { id: "plugins" as const, label: "插件", count: counts.value.plugins },
    { id: "scripts" as const, label: "单文件 JS", count: counts.value.scripts },
    { id: "disabled" as const, label: "已禁用", count: counts.value.disabled }
  ].filter(t => t.id === "disabled" || t.count > 0)
)
const inTab = computed(() => tilesOf(tiles.value, tab.value, query.value))
/** 筛选时别的页签里有几个匹配的，当前页签一个也没有时提一句 */
const elsewhere = computed(() =>
  query.value.trim() === "" || inTab.value.length > 0 ? [] : tabs.value.filter(t => t.id !== tab.value && tilesOf(tiles.value, t.id, query.value).length > 0)
)
/** 收起时整行整行地露；筛选与「已禁用」都是在找特定的几个，不收 */
const limited = computed(() => !showAll.value && query.value.trim() === "" && tab.value !== "disabled")
const shown = computed(() => (limited.value ? inTab.value.slice(0, visibleCount(cols.value, ROWS, inTab.value.length)) : inTab.value))
/** 有没有「展开全部 / 收起」可点 */
const foldable = computed(
  () => query.value.trim() === "" && tab.value !== "disabled" && inTab.value.length > visibleCount(cols.value, ROWS, inTab.value.length)
)

/** 格子与插在其间的那一格详情 */
const cells = computed(() => {
  const list: Array<{ key: string; tile: DisabledTile; detail: boolean }> = shown.value.map(tile => ({ key: tile.name, tile, detail: false }))
  const at = shown.value.findIndex(t => t.name === expanded.value)
  if (at >= 0) {
    const after = detailAfter(at, cols.value, shown.value.length)
    // 键取所在行而不取插件名：同一行里换着点，详情原地换内容；换到别的行才是收起一处、展开一处
    list.splice(after + 1, 0, { key: `detail@${after}`, tile: shown.value[at]!, detail: true })
  }
  return list
})

/**
 * 格子右下角那行小字
 * @param tile 格子
 * @returns 文案
 */
function metaOf(tile: DisabledTile): string {
  if (tile.whole) return "整个禁用"
  if (tile.added.length > 0) return `禁 ${tile.added.length}/${tile.cmds.length}`
  return `${tile.cmds.length} 条命令`
}

/**
 * 勾或不勾整个插件；勾上时清掉它的单条命令
 * @param name 插件名
 * @param on 是否勾上
 */
function setWhole(name: string, on: boolean): void {
  const rest = props.modelValue.filter(key => key !== name && !(on && key.startsWith(`${name}:`)))
  emit("update:modelValue", on ? [...rest, name] : rest)
}

/**
 * 加或删一条命令
 * @param name 插件名
 * @param cmd 命令名
 */
function toggleCmd(name: string, cmd: string): void {
  const key = `${name}:${cmd}`
  emit("update:modelValue", props.modelValue.includes(key) ? props.modelValue.filter(v => v !== key) : [...props.modelValue, key])
}

/**
 * 删一项
 * @param key 插件名或 `插件名:命令名`
 */
function drop(key: string): void {
  emit("update:modelValue", props.modelValue.filter(v => v !== key))
}

/** 展开全部或收起：一下子多出或少掉几行，外框跟着长高变矮 */
function toggleAll(): void {
  void tweenHeight(stage.value, async () => {
    showAll.value = !showAll.value
    if (!showAll.value && !shown.value.some(t => t.name === expanded.value)) expanded.value = ""
    await nextTick()
  })
}

/**
 * 点格子：展开或收起它的详情
 * @param name 插件名
 */
function toggleTile(name: string): void {
  expanded.value = expanded.value === name ? "" : name
}

// 详情那一格展开收起走量高度的钩子，普通格子离场前钉住原位
const cellHooks = {
  enter(el: Element): void {
    if ((el as HTMLElement).dataset.detail !== undefined) onExpandEnter(el)
  },
  afterEnter(el: Element): void {
    if ((el as HTMLElement).dataset.detail !== undefined) onExpandDone(el)
  },
  beforeLeave(el: Element): void {
    if ((el as HTMLElement).dataset.detail === undefined) pinLeaving(el)
  },
  leave(el: Element): void {
    if ((el as HTMLElement).dataset.detail !== undefined) onExpandLeave(el)
  }
}

/**
 * 网格是 `<TransitionGroup>` 画的 `ul`，ref 拿到的是组件实例，取它的根元素
 * @param comp 组件实例
 */
function setGrid(comp: unknown): void {
  grid.value = (comp as { $el?: HTMLElement } | null)?.$el ?? undefined
}

/** 量网格当前排几列：`grid-template-columns` 的计算值是一串像素宽，几段就是几列 */
function measure(): void {
  const el = grid.value
  if (el === undefined) return
  const n = getComputedStyle(el).gridTemplateColumns.split(" ").filter(s => s !== "").length
  if (n > 0 && n !== cols.value) cols.value = n
}

const sizes = new ResizeObserver(() => measure())
onMounted(() => {
  if (grid.value !== undefined) sizes.observe(grid.value)
})
onBeforeUnmount(() => sizes.disconnect())
// 网格随页签换一个新元素，跟着重挂
watch(
  grid,
  (el, old) => {
    if (old !== undefined) sizes.unobserve(old)
    if (el !== undefined) sizes.observe(el)
  },
  { flush: "post" }
)

watch(tab, () => {
  expanded.value = ""
  showAll.value = false
})

// 清单晚于组件到：只有单文件 JS 时默认落在那一页
watch(
  counts,
  c => {
    if (tab.value === "plugins" && c.plugins === 0 && c.scripts > 0) tab.value = "scripts"
  },
  { immediate: true }
)
</script>

<template>
  <div ref="root" class="dis-picker">
    <p v-if="tiles.length === 0" class="hint">还没有注册了命令的插件。</p>
    <template v-else>
      <div class="dis-bar">
        <div class="seg" role="radiogroup" aria-label="分类">
          <label v-for="t in tabs" :key="t.id">
            <input v-model="tab" type="radio" :value="t.id" :name="`${uid}-tab`" /><span>{{ t.label }}<small class="dis-count">{{ t.count }}</small></span>
          </label>
        </div>
        <input v-if="tiles.length > SEARCH_AT" v-model="query" type="search" class="dis-search" placeholder="筛选插件或命令" aria-label="筛选插件或命令" />
      </div>

      <div ref="stage" class="dis-stage">
        <Transition name="swap" mode="out-in" v-on="stageSwap">
          <div :key="tab">
            <TransitionGroup :ref="setGrid" tag="ul" name="cellfx" class="dis-grid" v-on="cellHooks">
              <template v-for="cell in cells" :key="cell.key">
                <li v-if="cell.detail" class="dis-detail" data-detail>
                  <div class="dis-detail-in">
                    <Transition name="swap" mode="out-in" v-on="swap">
                      <div :key="cell.tile.name">
                        <div class="dis-detail-head">
                          <b>{{ cell.tile.name }}</b>
                          <span v-if="cell.tile.script" class="tag">JS</span>
                          <span class="hint">{{ cell.tile.cmds.length }} 条命令</span>
                          <button type="button" class="link" @click="expanded = ''">收起</button>
                        </div>
                        <p v-if="cell.tile.whole" class="hint dis-note">整个禁用了，其中的命令都不响应。取消格子上的勾选后可以只禁其中几条。</p>
                        <p v-else-if="cell.tile.cmds.length === 0" class="hint dis-note">没有可单独禁用的命令。</p>
                        <template v-else>
                          <p class="hint dis-note">点 + 禁用这一条，点 × 恢复。</p>
                          <TransitionGroup name="pill" tag="div" class="dis-pills" @before-leave="pinLeaving">
                            <span v-for="cmd in cell.tile.cmds" :key="cmd" class="pill" :class="{ on: cell.tile.added.includes(cmd) }">
                              {{ cmd
                              }}<button
                                type="button"
                                class="pill-btn"
                                :aria-label="cell.tile.added.includes(cmd) ? `不再禁用 ${cmd}` : `禁用 ${cmd}`"
                                @click="toggleCmd(cell.tile.name, cmd)"
                              >
                                {{ cell.tile.added.includes(cmd) ? "×" : "+" }}
                              </button>
                            </span>
                          </TransitionGroup>
                        </template>
                      </div>
                    </Transition>
                  </div>
                </li>
                <li v-else class="dis-tile" :class="{ whole: cell.tile.whole, some: !cell.tile.whole && cell.tile.added.length > 0, open: expanded === cell.tile.name }">
                  <label class="check" :title="`整个禁用 ${cell.tile.name}`">
                    <input
                      type="checkbox"
                      :checked="cell.tile.whole"
                      :aria-label="`整个禁用 ${cell.tile.name}`"
                      @change="setWhole(cell.tile.name, ($event.target as HTMLInputElement).checked)"
                    /><span class="checkmark"></span>
                  </label>
                  <button type="button" class="dis-open" :aria-expanded="expanded === cell.tile.name" @click="toggleTile(cell.tile.name)">
                    <b :title="cell.tile.name">{{ cell.tile.name }}</b>
                    <small>{{ metaOf(cell.tile) }}<template v-if="tab === 'disabled' && cell.tile.script"> · JS</template></small>
                  </button>
                </li>
              </template>
            </TransitionGroup>
            <p v-if="inTab.length === 0" class="hint dis-empty">
              <template v-if="query.trim() !== ''">
                没有匹配「{{ query.trim() }}」的<template v-for="t in elsewhere" :key="t.id">
                  ，<button type="button" class="link" @click="tab = t.id">「{{ t.label }}」里有</button></template
                >
              </template>
              <template v-else-if="tab === 'disabled'">还没有禁用任何插件或命令。</template>
            </p>
            <button v-if="foldable" type="button" class="link dis-all" @click="toggleAll()">
              {{ showAll ? "收起" : `展开全部 ${inTab.length} 个` }}
            </button>
          </div>
        </Transition>
      </div>

      <div v-if="stale.length > 0" class="dis-stale">
        <span class="hint">不在清单里的</span>
        <TransitionGroup name="pill" tag="div" class="dis-pills" @before-leave="pinLeaving">
          <span v-for="key in stale" :key="key" class="pill on">
            {{ key }}<button type="button" class="pill-btn" :aria-label="`删掉 ${key}`" @click="drop(key)">×</button>
          </span>
        </TransitionGroup>
      </div>
    </template>
  </div>
</template>
