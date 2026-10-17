<script setup lang="ts">
/**
 * 模块职责：数据库页的「KV」页签 —— 按前缀浏览键，查看、编辑、另存、改名与删除
 * 依赖方向：依赖 api / confirm / dbpage / download / format / icons / storage / types 与 components 下的若干组件
 * 生命周期：随数据库页常驻；首次显示时读根前缀，或直接进入 `target` 指定的前缀
 * 注意事项：键为驱动层完整键；修改 `plugin:<名>:` 下的键即直接修改该插件的数据，插件不会收到通知。
 *
 *          删键一律经确认；清前缀与批量删除还须键入指定文字 —— 这两件事一次影响多条记录。
 */
import { computed, ref, watch } from "vue"
import { del, get, post, put } from "../api.js"
import { askConfirm } from "../confirm.js"
import { useDbPage } from "../dbpage.js"
import { showToast } from "../toast.js"
import { downloadText, fileNameOf } from "../download.js"
import { bytes, datetime, errorText } from "../format.js"
import { ICONS } from "../icons.js"
import {
  KV_TYPE_LABEL,
  TTL_PRESETS,
  crumbsOf,
  diffLines,
  diffStat,
  foldDiff,
  isSensitive,
  jsonBytes,
  kvTypeOf,
  parentOf,
  parseValueText,
  reformatJson,
  resolveExpireAt,
  sortKvItems,
  ttlText,
  valueTextOf,
  type KvSort,
  type TtlChoice,
  type ValueMode
} from "../storage.js"
import AppIcon from "./AppIcon.vue"
import DangerConfirm from "./DangerConfirm.vue"
import EmptyState from "./EmptyState.vue"
import JsonTree from "./JsonTree.vue"
import Modal from "./Modal.vue"
import type { KvEntry, KvItem, KvPage, KvValueType } from "../types.js"

/** 值大类的角标 */
const TYPE_GLYPH: Record<KvValueType, string> = {
  object: "{ }",
  array: "[ ]",
  string: "“ ”",
  number: "#",
  boolean: "01",
  null: "∅"
}

/** KV 每页键数 */
const KV_PAGE = 100

const props = defineProps<{
  /** 从概览跳来时要进入的前缀；每次跳转换一个新对象，同一前缀也会重新进入 */
  target?: { prefix: string }
}>()

const { error, busy, readonly, copy } = useDbPage()

/** 计算剩余存活时间的基准时刻，每次读取时刷新 */
const now = ref(Date.now())

const page = ref<KvPage | undefined>(undefined)
const prefix = ref("")
/** 前缀直达输入框 */
const jump = ref("")
/** 已翻过的各页起点，首页为 undefined */
const cursors = ref<(string | undefined)[]>([undefined])
/** 敏感键的内容是否显示 */
const revealed = ref(false)
/** 按键名筛选 */
const kvFilter = ref("")
/** 按值的大类筛选；空串为不限 */
const kvType = ref<"" | KvValueType>("")
const kvSort = ref<KvSort>("name")
const kvDesc = ref(false)
/** 勾选的键 */
const picked = ref(new Set<string>())

const crumbs = computed(() => crumbsOf(prefix.value))
const sensitiveHere = computed(() => page.value?.items.some(item => isSensitive(item.key)) === true)
/** 当前前缀之下的键总数，含子命名空间 */
const countHere = computed(() => (page.value?.total ?? 0) + (page.value?.groups.reduce((n, g) => n + g.count, 0) ?? 0))
/** 子命名空间中最大的键数，侧栏比例条以它为满格 */
const groupMax = computed(() => Math.max(1, ...(page.value?.groups ?? []).map(g => g.count)))

/** 经筛选与排序后的本页键 */
const shown = computed<KvItem[]>(() => {
  const all = page.value?.items ?? []
  const text = kvFilter.value.trim().toLowerCase()
  const type = kvType.value
  const kept = all.filter(
    item => (text === "" || item.key.toLowerCase().includes(text)) && (type === "" || item.type === type)
  )
  return sortKvItems(kept, kvSort.value, kvDesc.value)
})

/** 本页出现过的值的大类，供筛选下拉 */
const typesHere = computed(() => [...new Set((page.value?.items ?? []).map(item => item.type))])

const allPicked = computed(() => shown.value.length > 0 && shown.value.every(item => picked.value.has(item.key)))

/* ────────────────────────────── 取数 ────────────────────────────── */

/**
 * 读一页 KV
 * @param next 前缀
 * @param after 分页游标
 */
async function loadKv(next = prefix.value, after?: string): Promise<void> {
  busy.value = true
  try {
    const q = new URLSearchParams({ prefix: next, limit: String(KV_PAGE) })
    if (after !== undefined) q.set("after", after)
    page.value = await get<KvPage>(`storage/kv?${q.toString()}`)
    readonly.value = page.value.readonly
    prefix.value = next
    jump.value = next
    now.value = Date.now()
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 进入一个前缀，从首页读起
 * @param next 前缀
 */
function enter(next: string): void {
  cursors.value = [undefined]
  revealed.value = false
  picked.value = new Set()
  kvFilter.value = ""
  kvType.value = ""
  void loadKv(next)
}

/** 下一页 */
function nextPage(): void {
  const cursor = page.value?.next
  if (cursor === undefined) return
  cursors.value.push(cursor)
  void loadKv(prefix.value, cursor)
}

/** 上一页 */
function prevPage(): void {
  if (cursors.value.length <= 1) return
  cursors.value.pop()
  void loadKv(prefix.value, cursors.value[cursors.value.length - 1])
}

/** 原地重读当前页 */
function reloadKv(): Promise<void> {
  return loadKv(prefix.value, cursors.value[cursors.value.length - 1])
}

/* ────────────────────────────── 键的查看与编辑 ────────────────────────────── */

const editing = ref(false)
const isNew = ref(false)
const editKey = ref("")
const editMode = ref<ValueMode>("json")
const editText = ref("")
/** 打开时的文本，用于差异 */
const editOrigin = ref("")
const editExpireAt = ref<number | undefined>(undefined)
const ttlChoice = ref<TtlChoice>("keep")
/** 自定义过期的秒数 */
const ttlCustom = ref("")
const editError = ref("")
/** 敏感键的内容是否先隐去 */
const editHidden = ref(false)
/** 抽屉里的三种视图 */
const editView = ref<"tree" | "edit" | "diff">("tree")

/** 文本当前是否可解析，以及解析出的值 */
const parsed = computed(() => parseValueText(editText.value, editMode.value))
/** 树形视图要展示的值 */
const treeValue = computed(() => (parsed.value.ok ? parsed.value.value : undefined))
const changed = computed(() => editText.value !== editOrigin.value)
/** 折叠后的差异 */
const diff = computed(() => foldDiff(diffLines(editOrigin.value, editText.value)))
const diffCount = computed(() => diffStat(diffLines(editOrigin.value, editText.value)))
/** 值序列化后的字节数 */
const editBytes = computed(() => (parsed.value.ok ? jsonBytes(parsed.value.value) : 0))
const lineCount = computed(() => editText.value.split("\n").length)

/** 有效期一栏下方的说明 */
const ttlNote = computed(() => {
  if (ttlChoice.value === "never") return "写入后永不过期"
  if (ttlChoice.value !== "keep") return "按所选时长从写入时刻重新计时"
  return editExpireAt.value === undefined ? "当前永不过期" : `当前 ${datetime(editExpireAt.value)} 过期`
})

/**
 * 打开一个已有的键
 * @param key 完整键
 */
async function openEntry(key: string): Promise<void> {
  try {
    const entry = await get<KvEntry>(`storage/kv/entry?key=${encodeURIComponent(key)}`)
    const { mode, text } = valueTextOf(entry.value)
    isNew.value = false
    editKey.value = key
    editMode.value = mode
    editText.value = text
    editOrigin.value = text
    editExpireAt.value = entry.expireAt
    ttlChoice.value = "keep"
    ttlCustom.value = ""
    editError.value = ""
    editHidden.value = isSensitive(key) && !revealed.value
    editView.value = "tree"
    now.value = Date.now()
    editing.value = true
  } catch (err) {
    error.value = errorText(err)
  }
}

/** 新建一个键，键名预填当前前缀 */
function openNew(): void {
  isNew.value = true
  editKey.value = prefix.value
  editMode.value = "json"
  editText.value = ""
  editOrigin.value = ""
  editExpireAt.value = undefined
  ttlChoice.value = "never"
  ttlCustom.value = ""
  editError.value = ""
  editHidden.value = false
  editView.value = "edit"
  editing.value = true
}

/**
 * 重排 JSON
 * @param pretty 为真时缩进两格，否则压缩为一行
 */
function format(pretty: boolean): void {
  const done = reformatJson(editText.value, pretty)
  if (!done.ok) {
    editError.value = done.error
    return
  }
  editText.value = done.text
  editError.value = ""
}

/** 保存抽屉里的键 */
async function saveEntry(): Promise<void> {
  const key = editKey.value.trim()
  if (key === "") {
    editError.value = "键不能为空"
    return
  }
  const value = parseValueText(editText.value, editMode.value)
  if (!value.ok) {
    editError.value = value.error
    return
  }
  const at = resolveExpireAt(ttlChoice.value, ttlCustom.value, editExpireAt.value, Date.now())
  if (!at.ok) {
    editError.value = at.error
    return
  }

  if (isNew.value && !(await confirmOverwrite(key))) return

  busy.value = true
  try {
    await put("storage/kv/entry", { key, value: value.value, ...(at.expireAt === undefined ? {} : { expireAt: at.expireAt }) })
    editing.value = false
    showToast(`已保存 ${key}`)
    await reloadKv()
  } catch (err) {
    editError.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/**
 * 键已存在时征询是否覆盖
 * @param key 完整键
 * @returns 是否继续写入
 */
async function confirmOverwrite(key: string): Promise<boolean> {
  const exists = await get(`storage/kv/entry?key=${encodeURIComponent(key)}`).then(
    () => true,
    () => false
  )
  if (!exists) return true
  return askConfirm({
    title: `键 ${key} 已存在，覆盖？`,
    body: "原值将被替换，此操作无法撤销。",
    okText: "覆盖",
    danger: true
  })
}

/**
 * 删一个键
 * @param key 完整键
 */
async function removeEntry(key: string): Promise<void> {
  const ok = await askConfirm({
    title: `删除键 ${key}？`,
    body: "该键及其值将被移除，此操作无法撤销。",
    okText: "删除",
    danger: true
  })
  if (!ok) return
  try {
    await del(`storage/kv/entry?key=${encodeURIComponent(key)}`)
    editing.value = false
    showToast(`已删除 ${key}`)
    await reloadKv()
  } catch (err) {
    error.value = errorText(err)
  }
}

/* ───── 另存与改名 ───── */

const copyTo = ref(false)
/** 另存或改名的目标键 */
const copyKey = ref("")
/** 为真时写入后删除原键 */
const copyMove = ref(false)

/**
 * 打开另存框
 * @param move 为真时写入新键后删除原键
 */
function openCopy(move: boolean): void {
  copyMove.value = move
  copyKey.value = editKey.value
  copyTo.value = true
}

/** 另存或改名 */
async function saveCopy(): Promise<void> {
  const target = copyKey.value.trim()
  const from = editKey.value
  if (target === "" || target === from) {
    editError.value = "请填写一个不同的键"
    return
  }
  const value = parseValueText(editText.value, editMode.value)
  if (!value.ok) {
    editError.value = value.error
    return
  }
  if (!(await confirmOverwrite(target))) return

  busy.value = true
  try {
    await put("storage/kv/entry", {
      key: target,
      value: value.value,
      ...(editExpireAt.value === undefined ? {} : { expireAt: editExpireAt.value })
    })
    if (copyMove.value) await del(`storage/kv/entry?key=${encodeURIComponent(from)}`)
    copyTo.value = false
    editing.value = false
    showToast(copyMove.value ? `已改名为 ${target}` : `已另存为 ${target}`)
    await reloadKv()
  } catch (err) {
    editError.value = errorText(err)
  } finally {
    busy.value = false
  }
}

/** 把当前键的值存成文件 */
function downloadEntry(): void {
  downloadText(`${fileNameOf(editKey.value)}.json`, editText.value, editMode.value === "json" ? "application/json" : "text/plain")
}

/* ────────────────────────────── 危险操作 ────────────────────────────── */

/** 一次须键入确认文字的操作 */
interface DangerAsk {
  /** 标题 */
  title: string
  /** 说明影响范围 */
  body: string
  /** 须键入的文字 */
  expected: string
  /** 额外警示 */
  warning?: string
  /** 受影响的样例 */
  samples?: string[]
  /** 确认按钮文案 */
  okText?: string
  /** 确认后执行 */
  run: () => Promise<void>
}

const danger = ref<DangerAsk | undefined>(undefined)

/** 执行已确认的危险操作 */
async function runDanger(): Promise<void> {
  const ask = danger.value
  if (ask === undefined) return
  busy.value = true
  try {
    await ask.run()
    danger.value = undefined
  } catch (err) {
    error.value = errorText(err)
    danger.value = undefined
  } finally {
    busy.value = false
  }
}

/**
 * 清空一个前缀：删除其下全部键
 * @param target 前缀
 */
function askClearPrefix(target: string): void {
  const sample = (page.value?.items ?? []).slice(0, 5).map(item => item.key)
  danger.value = {
    title: "删除此前缀下的全部键",
    body: `将删除以 ${target} 开头的全部键，约 ${countHere.value} 个，含各级子命名空间。数据立即从存储中移除，无法撤销。`,
    expected: target,
    warning: target.startsWith("plugin:")
      ? "这是插件的命名空间，删除后该插件保存的数据全部丢失，且插件不会收到通知。"
      : undefined,
    samples: sample,
    okText: "删除全部",
    run: async () => {
      const done = await post<{ removed: number }>("storage/kv/clear", { prefix: target })
      showToast(`已删除 ${target} 之下的 ${done.removed} 个键`)
      enter(prefix.value)
    }
  }
}

/** 删除勾选的键 */
function askRemovePicked(): void {
  const keys = [...picked.value]
  if (keys.length === 0) return
  danger.value = {
    title: `删除勾选的 ${keys.length} 个键`,
    body: "这些键及其值将被移除，此操作无法撤销。",
    expected: "删除",
    samples: keys.slice(0, 5),
    okText: "删除",
    run: async () => {
      let removed = 0
      for (const key of keys) {
        await del(`storage/kv/entry?key=${encodeURIComponent(key)}`)
        removed++
      }
      picked.value = new Set()
      showToast(`已删除 ${removed} 个键`)
      await reloadKv()
    }
  }
}

/**
 * 勾选或取消一个键
 * @param key 完整键
 */
function togglePick(key: string): void {
  if (picked.value.has(key)) picked.value.delete(key)
  else picked.value.add(key)
}

/** 全选或全不选本页（已筛选）的键 */
function toggleAll(): void {
  if (allPicked.value) picked.value = new Set()
  else picked.value = new Set(shown.value.map(item => item.key))
}

watch(
  () => props.target,
  target => {
    if (target !== undefined) enter(target.prefix)
    else if (page.value === undefined) void loadKv("")
  },
  { immediate: true }
)

defineExpose({ refresh: reloadKv })
</script>

<template>
  <div>
    <div class="db-split">
      <aside class="card db-aside">
        <h2>命名空间</h2>
        <nav class="crumbs" aria-label="当前前缀">
          <button v-for="crumb in crumbs" :key="crumb.prefix" :disabled="crumb.prefix === prefix" @click="enter(crumb.prefix)">
            {{ crumb.label }}
          </button>
        </nav>
        <button v-if="prefix !== ''" class="link db-back" @click="enter(parentOf(prefix))">
          <AppIcon class="btn-ico" :path="ICONS.back" />返回上一级
        </button>
        <ul v-if="page && page.groups.length > 0" class="plain ns-list">
          <li v-for="group in page.groups" :key="group.name">
            <button class="ns-item" @click="enter(prefix + group.name)">
              <AppIcon class="ns-ico" :path="ICONS.folder" />
              <span class="mono ns-name">{{ group.name }}</span>
              <span class="ns-count">{{ group.count }}</span>
              <span class="ns-bar" :style="{ transform: `scaleX(${group.count / groupMax})` }"></span>
            </button>
          </li>
        </ul>
        <p v-else class="hint">此前缀下没有子命名空间。</p>
      </aside>

      <section class="db-main">
        <p v-if="page" class="hint">
          驱动 <span class="mono">{{ page.driver }}</span>。当前前缀
          <span class="mono">{{ prefix || "（根）" }}</span>，直属 {{ page.total }} 个键，连子命名空间共 {{ countHere }} 个。
        </p>

        <div class="toolbar">
          <input
            v-model="jump"
            type="search"
            placeholder="输入前缀直达，如 plugin:webui:"
            aria-label="前缀"
            @keyup.enter="enter(jump)"
          />
          <button class="db-btn" @click="enter(jump)"><AppIcon class="btn-ico" :path="ICONS.next" />前往</button>
          <button v-if="!readonly" class="primary db-btn" @click="openNew()">
            <AppIcon class="btn-ico" :path="ICONS.plus" />新建键
          </button>
        </div>

        <div class="toolbar">
          <input v-model="kvFilter" type="search" placeholder="在本页按键名筛选" aria-label="筛选键名" />
          <select v-model="kvType" aria-label="按类型筛选">
            <option value="">全部类型</option>
            <option v-for="type in typesHere" :key="type" :value="type">{{ KV_TYPE_LABEL[type] }}</option>
          </select>
          <select v-model="kvSort" aria-label="排序依据">
            <option value="name">按键名</option>
            <option value="size">按大小</option>
            <option value="expire">按过期时间</option>
          </select>
          <button class="db-btn" :aria-label="kvDesc ? '降序' : '升序'" @click="kvDesc = !kvDesc">
            <AppIcon class="btn-ico" :path="kvDesc ? ICONS.sortDesc : ICONS.sortAsc" />{{ kvDesc ? "降序" : "升序" }}
          </button>
          <label v-if="sensitiveHere" class="check">
            <input v-model="revealed" type="checkbox" />
            <span class="checkmark"></span>
            显示账号与适配器数据
          </label>
        </div>

        <div v-if="page && shown.length > 0" class="card">
          <table class="rows">
            <thead>
              <tr>
                <th v-if="!readonly" class="db-sel">
                  <label class="check" aria-label="全选本页">
                    <input type="checkbox" :checked="allPicked" @change="toggleAll()" />
                    <span class="checkmark"></span>
                  </label>
                </th>
                <th>键</th>
                <th>类型</th>
                <th>大小</th>
                <th>预览</th>
                <th>过期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in shown" :key="item.key">
                <td v-if="!readonly" data-label="勾选" class="db-sel">
                  <label class="check" :aria-label="`勾选 ${item.key}`">
                    <input type="checkbox" :checked="picked.has(item.key)" @change="togglePick(item.key)" />
                    <span class="checkmark"></span>
                  </label>
                </td>
                <td data-label="键" class="mono">
                  <button class="kv-key" @click="void openEntry(item.key)">{{ item.key.slice(prefix.length) }}</button>
                </td>
                <td data-label="类型">
                  <span class="kv-type" :class="`kv-type-${item.type}`">
                    <i aria-hidden="true">{{ TYPE_GLYPH[item.type] }}</i>{{ KV_TYPE_LABEL[item.type] }}
                  </span>
                </td>
                <td data-label="大小">{{ bytes(item.size) }}</td>
                <td data-label="预览" class="kv-preview">
                  <span v-if="isSensitive(item.key) && !revealed" class="hint">（已隐去）</span>
                  <template v-else>{{ item.preview }}</template>
                </td>
                <td data-label="过期">{{ ttlText(item.expireAt, now) || "永不" }}</td>
                <td data-label="操作">
                  <div class="row db-row-ops">
                    <button
                      class="icon-btn"
                      :aria-label="readonly ? '查看' : '编辑'"
                      :title="readonly ? '查看' : '编辑'"
                      @click="void openEntry(item.key)"
                    >
                      <AppIcon :path="readonly ? ICONS.eye : ICONS.edit" />
                    </button>
                    <button class="icon-btn" aria-label="复制键名" title="复制键名" @click="void copy(item.key, '键名')">
                      <AppIcon :path="ICONS.copy" />
                    </button>
                    <button
                      v-if="!readonly"
                      class="icon-btn danger"
                      aria-label="删除"
                      title="删除"
                      @click="void removeEntry(item.key)"
                    >
                      <AppIcon :path="ICONS.trash" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="page && page.items.length > 0" class="card">
          <EmptyState :icon="ICONS.filter" title="筛选条件下本页没有键" hint="换个关键词，或把类型改回「全部类型」。" />
        </div>
        <div v-else-if="page && page.groups.length === 0" class="card">
          <EmptyState :icon="ICONS.key" title="该前缀下没有键" :hint="readonly ? undefined : '可以在这里新建一个。'">
            <button v-if="!readonly" class="primary" @click="openNew()">
              <AppIcon class="btn-ico" :path="ICONS.plus" />新建键
            </button>
          </EmptyState>
        </div>

        <div v-if="page && (cursors.length > 1 || page.next !== undefined)" class="row db-pager">
          <button :disabled="cursors.length <= 1 || busy" @click="prevPage()">
            <AppIcon class="btn-ico" :path="ICONS.prev" />上一页
          </button>
          <button :disabled="page.next === undefined || busy" @click="nextPage()">
            下一页<AppIcon class="btn-ico" :path="ICONS.next" />
          </button>
          <span class="hint">第 {{ cursors.length }} 页，每页 {{ KV_PAGE }} 个键</span>
        </div>

        <p v-if="page?.truncated" class="hint">键数超过扫描上限，仅统计前 50000 个。请进入下级前缀查看。</p>

        <div v-if="!readonly && page" class="card danger-zone">
          <h2><AppIcon class="btn-ico" :path="ICONS.alert" />危险操作</h2>
          <p class="hint">以下操作会删除数据，立即生效且无法撤销。执行前须键入指定文字确认。</p>
          <div class="row">
            <button class="danger" :disabled="picked.size === 0" @click="askRemovePicked()">
              删除勾选的 {{ picked.size }} 个键
            </button>
            <button class="danger" :disabled="prefix === '' || countHere === 0" @click="askClearPrefix(prefix)">
              删除 {{ prefix || "根前缀" }} 下的全部键（约 {{ countHere }} 个）
            </button>
          </div>
          <p v-if="prefix === ''" class="hint">根前缀不提供整体删除，请先进入一个命名空间。</p>
        </div>
      </section>
    </div>

    <!-- 键的查看与编辑，宽屏贴右展开 -->
    <Modal
      :open="editing"
      wide
      side
      :title="isNew ? '新建键' : editKey"
      :sub="isNew ? '写入后即对插件生效' : `${KV_TYPE_LABEL[kvTypeOf(treeValue)]} · ${bytes(editBytes)} · ${ttlText(editExpireAt, now) || '永不过期'}`"
      @close="editing = false"
    >
      <p v-if="editError !== ''" class="banner">{{ editError }}</p>

      <div v-if="isNew" class="field">
        <label for="kvKey">键</label>
        <input id="kvKey" v-model="editKey" class="mono" placeholder="plugin:示例:键名" />
      </div>

      <p v-if="editHidden" class="banner warn">
        账号与适配器数据含连接令牌，默认隐藏。
        <button class="link" type="button" @click="editHidden = false">仍要显示</button>
      </p>

      <template v-else>
        <div class="db-seg" role="tablist">
          <button role="tab" :aria-selected="editView === 'tree'" :class="{ on: editView === 'tree' }" @click="editView = 'tree'">
            <AppIcon class="btn-ico" :path="ICONS.tree" />结构
          </button>
          <button role="tab" :aria-selected="editView === 'edit'" :class="{ on: editView === 'edit' }" @click="editView = 'edit'">
            <AppIcon class="btn-ico" :path="ICONS.edit" />{{ readonly ? "原文" : "编辑" }}
          </button>
          <button
            role="tab"
            :aria-selected="editView === 'diff'"
            :class="{ on: editView === 'diff' }"
            :disabled="!changed"
            @click="editView = 'diff'"
          >
            <AppIcon class="btn-ico" :path="ICONS.diff" />改动
            <span v-if="changed" class="db-seg-badge"><i class="add">+{{ diffCount.add }}</i><i class="del">-{{ diffCount.del }}</i></span>
          </button>
        </div>

        <!-- 结构 -->
        <div v-if="editView === 'tree'" class="db-tree">
          <p v-if="!parsed.ok" class="hint">文本当前不是合法 JSON，无法按结构展示。</p>
          <JsonTree v-else :value="treeValue" />
        </div>

        <!-- 差异 -->
        <div v-else-if="editView === 'diff'" class="db-diff">
          <p v-for="(line, i) in diff" :key="i" class="diff-line" :class="`diff-${line.op}`">
            <template v-if="line.op === 'gap'">… 省略 {{ line.count }} 行未改动</template>
            <template v-else>{{ line.op === "add" ? "+" : line.op === "del" ? "-" : " " }} {{ line.text }}</template>
          </p>
        </div>

        <!-- 编辑 -->
        <div v-else class="db-editor" :class="{ bad: !parsed.ok }">
          <div class="db-editor-bar">
            <select v-model="editMode" class="db-editor-mode" aria-label="值的写法" :disabled="readonly">
              <option value="json">JSON</option>
              <option value="text">文本（存为字符串）</option>
            </select>
            <template v-if="editMode === 'json' && !readonly">
              <button class="db-chip" @click="format(true)"><AppIcon class="btn-ico" :path="ICONS.code" />格式化</button>
              <button class="db-chip" @click="format(false)">压缩</button>
            </template>
          </div>
          <textarea
            id="kvValue"
            v-model="editText"
            rows="16"
            class="mono db-editor-text"
            aria-label="值"
            spellcheck="false"
            :readonly="readonly"
          />
          <p class="db-editor-status" :class="{ err: !parsed.ok }">
            <AppIcon class="btn-ico" :path="parsed.ok ? ICONS.check : ICONS.alert" />
            <span>{{ parsed.ok ? `合法 · ${bytes(editBytes)} · ${lineCount} 行` : parsed.error }}</span>
          </p>
        </div>

        <section v-if="!readonly" class="db-ttl">
          <h3><AppIcon class="btn-ico" :path="ICONS.clock" />有效期</h3>
          <div class="db-chips">
            <button v-if="!isNew" class="db-chip" :class="{ on: ttlChoice === 'keep' }" @click="ttlChoice = 'keep'">保持原样</button>
            <button class="db-chip" :class="{ on: ttlChoice === 'never' }" @click="ttlChoice = 'never'">永不过期</button>
            <button
              v-for="preset in TTL_PRESETS"
              :key="preset.sec"
              class="db-chip"
              :class="{ on: ttlChoice === preset.sec }"
              @click="ttlChoice = preset.sec"
            >
              {{ preset.label }}
            </button>
            <button class="db-chip" :class="{ on: ttlChoice === 'custom' }" @click="ttlChoice = 'custom'">自定义</button>
          </div>
          <input
            v-if="ttlChoice === 'custom'"
            v-model="ttlCustom"
            inputmode="decimal"
            placeholder="多少秒后过期"
            aria-label="多少秒后过期"
          />
          <p class="hint">{{ ttlNote }}</p>
        </section>

        <div class="db-entry-ops">
          <button class="db-chip" @click="void copy(editText, '值')"><AppIcon class="btn-ico" :path="ICONS.copy" />复制值</button>
          <button class="db-chip" @click="downloadEntry()"><AppIcon class="btn-ico" :path="ICONS.download" />下载</button>
          <button v-if="!isNew && !readonly" class="db-chip" @click="openCopy(false)">
            <AppIcon class="btn-ico" :path="ICONS.file" />另存为…
          </button>
          <button v-if="!isNew && !readonly" class="db-chip" @click="openCopy(true)">
            <AppIcon class="btn-ico" :path="ICONS.edit" />改名…
          </button>
        </div>
      </template>

      <template #actions>
        <button v-if="!isNew && !readonly" class="danger" @click="void removeEntry(editKey)">删除</button>
        <button @click="editing = false">{{ readonly ? "关闭" : "取消" }}</button>
        <button v-if="!readonly" class="primary" :disabled="busy || editHidden || !parsed.ok" @click="void saveEntry()">
          保存
        </button>
      </template>
    </Modal>

    <!-- 另存与改名 -->
    <Modal
      :open="copyTo"
      :title="copyMove ? '改名' : '另存为'"
      :sub="copyMove ? '先写入新键，再删除原键；两步之间若出错会留下两个键' : '以当前值写入另一个键，原键保持不变'"
      @close="copyTo = false"
    >
      <div class="field">
        <label for="kvCopy">目标键</label>
        <input id="kvCopy" v-model="copyKey" class="mono" @keyup.enter="void saveCopy()" />
      </div>
      <template #actions>
        <button @click="copyTo = false">取消</button>
        <button class="primary" :disabled="busy" @click="void saveCopy()">{{ copyMove ? "改名" : "另存" }}</button>
      </template>
    </Modal>

    <!-- 须键入确认文字的删除 -->
    <DangerConfirm
      :open="danger !== undefined"
      :title="danger?.title ?? ''"
      :body="danger?.body ?? ''"
      :expected="danger?.expected ?? ''"
      :warning="danger?.warning"
      :samples="danger?.samples"
      :ok-text="danger?.okText"
      :busy="busy"
      @close="danger = undefined"
      @confirm="void runDanger()"
    />
  </div>
</template>
