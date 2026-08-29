<script setup lang="ts">
/**
 * 模块职责：一份配置的表单编辑器 —— 读取、改动记账、保存、恢复默认值
 * 依赖方向：依赖 api / configedit / confirm / SchemaForm / types
 * 生命周期：随调用方；`name` 变化即重新读取
 * 注意事项：从 `ConfigView.vue` 里剖出来的：两个调用方（配置页的内核配置、插件页模态里的
 *          插件配置）共用同一套保存逻辑，其中「补丁 vs 整份替换」那一段是踩出来的，
 *          复制一份则下一次只会有一处被改对。算法本身在 `configedit.ts` 里，有用例钉着。
 *
 *          **保存提交的是补丁，而非整份值**（仅改过的路径，经 `PATCH` 深合并）。理由见
 *          `SchemaForm.vue` 的文件头：整份提交会在面板产物版本低于内核时抹除新增的配置项。
 *
 *          **例外是「删掉了字典里的键」那一次**：深合并表达不了删除，故改走 `PUT`。代价是
 *          那一次会连带覆盖别处对同一文件的手改，故提示文案里明说了这一点。
 *
 *          400 响应中的 `issues` 直接回填表单并标注到对应字段：服务端校验失败时既不改内存
 *          值也不写文件，页面上的值仍是使用者期望的那一份。
 *
 *          动作行带 `config-actions`：**在模态里**它常驻内容区底部（样式在 `styles.css` 的
 *          `.sheet-body .config-actions`），否则长表单会把「保存」推到滚动区之外。配置页里
 *          这个类名不起作用 —— 那一页整页滚动，钉住反倒一直压着内容。
 */
import { computed, ref, watch } from "vue"
import { ApiError, get, patch, post, put } from "../api.js"
import { assignPath, buildPatch, needsReplace, snapshot } from "../configedit.js"
import { errorText } from "../format.js"
import { askConfirm } from "../confirm.js"
import SchemaForm from "./SchemaForm.vue"
import type { ConfigDetail, SchemaIssue } from "../types.js"

const props = defineProps<{
  /** 要编辑哪一份配置 */
  name: string
}>()

const emit = defineEmits<{
  /** 保存或恢复默认值成功 */
  saved: []
}>()

const current = ref<ConfigDetail | undefined>(undefined)
const issues = ref<readonly SchemaIssue[]>([])
const error = ref("")
const notice = ref("")
const saving = ref(false)
/** 改动过的路径 → 新值 */
const dirty = ref<Record<string, unknown>>({})

/** 是否存在未保存的改动 */
const hasChanges = computed(() => Object.keys(dirty.value).length > 0)

/** 当前配置的标题与文件路径，供调用方在标题栏里用 */
defineExpose({ hasChanges, current })

/**
 * 服务端那一份值的副本，取自最近一次读取或保存
 *
 * `onChange` 会就地改写 `current.value`（`showWhen` 需要同级字段的当前值），因此判断
 * 「有没有删掉过键」时已无从与原值比较。此处另存一份不受改写影响的副本。
 */
let pristine: Record<string, unknown> = {}

/** 读取当前配置 */
async function load(): Promise<void> {
  dirty.value = {}
  issues.value = []
  notice.value = ""
  try {
    current.value = await get<ConfigDetail>(`config/${encodeURIComponent(props.name)}`)
    pristine = snapshot(current.value.value)
    error.value = ""
  } catch (err) {
    current.value = undefined
    error.value = errorText(err)
  }
}

/**
 * 记录一项改动，并就地更新页面上的值
 * @param path 点号路径
 * @param value 新值
 */
function onChange(path: string, value: unknown): void {
  dirty.value = { ...dirty.value, [path]: value }
  notice.value = ""
  const detail = current.value
  if (detail !== undefined) assignPath(detail.value, path, value)
}

/** 保存 */
async function save(): Promise<void> {
  const detail = current.value
  if (detail === undefined) return
  saving.value = true
  issues.value = []
  error.value = ""
  const whole = needsReplace(dirty.value, pristine)
  try {
    const url = `config/${encodeURIComponent(detail.name)}`
    const res = whole
      ? await put<{ value: Record<string, unknown> }>(url, detail.value)
      : await patch<{ value: Record<string, unknown> }>(url, buildPatch(dirty.value))
    current.value = { ...detail, value: res.value }
    pristine = snapshot(res.value)
    dirty.value = {}
    notice.value = whole
      ? "已保存并立即生效。本次改动删除了字典中的条目，因此提交的是整份配置 —— 若保存期间有人手改过该文件，其改动会被覆盖。"
      : "已保存并立即生效。修改监听端口需重启进程后方可应用。"
    emit("saved")
  } catch (err) {
    if (err instanceof ApiError && err.issues.length > 0) issues.value = err.issues
    error.value = errorText(err)
  } finally {
    saving.value = false
  }
}

/** 恢复默认值 */
async function reset(): Promise<void> {
  const detail = current.value
  if (detail === undefined) return
  const ok = await askConfirm({
    title: `将「${detail.title}」恢复为默认值？`,
    body: "该操作直接写入配置文件，当前的全部取值将被覆盖，无法撤销。",
    okText: "恢复默认值",
    danger: true,
    details: [`配置文件：${detail.file}`, "改动即刻生效；修改监听端口需重启进程后方可应用。"]
  })
  if (!ok) return
  saving.value = true
  try {
    const res = await post<{ value: Record<string, unknown> }>(`config/${encodeURIComponent(detail.name)}/reset`)
    current.value = { ...detail, value: res.value }
    pristine = snapshot(res.value)
    dirty.value = {}
    issues.value = []
    notice.value = "已恢复默认值"
    error.value = ""
    emit("saved")
  } catch (err) {
    error.value = errorText(err)
  } finally {
    saving.value = false
  }
}

watch(() => props.name, () => void load(), { immediate: true })
</script>

<template>
  <div>
    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <template v-if="current">
      <p class="hint mono">{{ current.file }}</p>
      <SchemaForm
        :schema="current.schema"
        :value="current.value"
        :issues="issues"
        :dirty="Object.keys(dirty)"
        @change="onChange"
      />

      <div class="row config-actions">
        <button class="primary" :disabled="!hasChanges || saving" @click="void save()">
          {{ saving ? "保存中…" : hasChanges ? `保存 ${Object.keys(dirty).length} 处改动` : "无改动" }}
        </button>
        <button v-if="hasChanges" :disabled="saving" @click="void load()">放弃改动</button>
        <button class="danger" :disabled="saving" @click="void reset()">恢复默认值</button>
      </div>
    </template>
  </div>
</template>
