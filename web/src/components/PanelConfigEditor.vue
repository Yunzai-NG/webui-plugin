<script setup lang="ts">
/**
 * 模块职责：一个面板插件包的配置表单 —— 就地改、整份保存、恢复默认值
 * 依赖方向：依赖 api / configedit / confirm / panelconfig / SchemaForm
 * 生命周期：随所在模态；`pkg` 变化即换一份值
 * 注意事项：**不复用 `ConfigEditor.vue`** —— 那一个绑在内核的 `config/:name` 三条端点上，
 *          端点与提交方式都不同：
 *
 *          - **整份提交，不走补丁。** 内核配置走补丁是防「面板产物版本低于内核」时抹掉渲染
 *            不出的新增字段；这里 schema 与值来自同一份 package.json，不存在那种错位，
 *            故 `needsReplace` / `buildPatch` 在此不需要。
 *          - **保存成功才动那份共享值。** 边打字边写共享值的话，关掉模态后卡片上显示的是没
 *            保存的数、刷新又变回去，看起来像「保存没生效」。改完即生效指的是保存之后不必
 *            刷新页面：用 node 侧送回的归一化结果覆盖共享值，用到它的组件随之重算。
 *
 *          **「放弃改动」不发请求**：共享的那一份就是服务端最近一次给的值（清单送来，或上次
 *          保存的回执），照它重造草稿即可。
 *
 *          **只读模式（`server.readonly`）拦不住这里** —— 那是内核对 `/api` 之下写请求的策略，
 *          而这两条端点在 webui 自己的 scope 下、且插件读不到那个开关。同 `src/index.ts` 的
 *          `PANEL_CONFIG_ENDPOINT`。
 */
import { computed, ref, watch } from "vue"
import { ApiError, postAt, putAt } from "../api.js"
import { assignPath, snapshot } from "../configedit.js"
import { errorText } from "../format.js"
import { askConfirm } from "../confirm.js"
import { configUrlOf, panelConfigOf, setPanelConfigValue } from "../panelconfig.js"
import SchemaForm from "./SchemaForm.vue"
import type { SchemaIssue } from "../types.js"

const props = defineProps<{
  /** 要配置哪个包，形如 `panels/hardware` */
  pkg: string
}>()

const issues = ref<readonly SchemaIssue[]>([])
const error = ref("")
const notice = ref("")
const saving = ref(false)
/**
 * 改动过的路径，供按钮计数与分区页签的角标
 *
 * **记路径而非记次数。** 计次数时同一个字段改两回就成了「2 处改动」，而使用者只动过一处；
 * 表单那边的分区角标也无从知道那一处落在哪一栏。提交的仍是整份草稿，与这份账本无关。
 */
const touched = ref<string[]>([])
/** 表单编辑的那一份，与共享值隔开，理由见文件头 */
const draft = ref<Record<string, unknown>>({})

/** 这个包的配置记录；没有配置项的包不该走到这里 */
const entry = computed(() => panelConfigOf(props.pkg))

/** 是否有未保存的改动 */
const hasChanges = computed(() => touched.value.length > 0)

defineExpose({ hasChanges })

/** 照共享的那一份重造草稿，并清掉上一轮的提示 */
function restart(): void {
  draft.value = snapshot(entry.value?.value.value ?? {})
  touched.value = []
  issues.value = []
  notice.value = ""
  error.value = ""
}

/**
 * 记录一项改动，就地写进草稿
 *
 * 就地写是必要的：`showWhen` 依赖同级字段的**当前**值，只记补丁的话，改了 `mode` 之后
 * 依赖它的字段不会随之显隐。`ref` 里的对象是深响应的，故就地改也会重绘表单。
 * @param path 点号路径
 * @param next 新值
 */
function onChange(path: string, next: unknown): void {
  if (!assignPath(draft.value, path, next)) return
  if (!touched.value.includes(path)) touched.value = [...touched.value, path]
  notice.value = ""
}

/** 保存整份值 */
async function save(): Promise<void> {
  saving.value = true
  issues.value = []
  error.value = ""
  try {
    const res = await putAt<{ value: Record<string, unknown>; issues?: readonly SchemaIssue[] }>(
      configUrlOf(props.pkg),
      draft.value
    )
    setPanelConfigValue(props.pkg, res.value)
    draft.value = snapshot(res.value)
    touched.value = []
    const dropped = (res.issues ?? []).filter(item => item.severity === "warn")
    notice.value =
      dropped.length === 0
        ? "已保存并立即生效，无须刷新页面。"
        : `已保存并立即生效。其中 ${dropped.length} 个字段不在这个包的声明里，已丢弃 —— 多半是这个包更新后删掉了它们。`
  } catch (err) {
    if (err instanceof ApiError && err.issues.length > 0) issues.value = err.issues
    error.value = errorText(err)
  } finally {
    saving.value = false
  }
}

/** 恢复默认值：删掉那份文件 */
async function reset(): Promise<void> {
  const ok = await askConfirm({
    title: `将「${props.pkg}」的配置恢复为默认值？`,
    body: "该操作删除这个包的配置文件，当前的全部取值将被覆盖，无法撤销。",
    okText: "恢复默认值",
    danger: true,
    details: ["默认值取自这个包 package.json 里的声明", "改动即刻生效，无须刷新页面"]
  })
  if (!ok) return
  saving.value = true
  try {
    const res = await postAt<{ value: Record<string, unknown> }>(`${configUrlOf(props.pkg)}/reset`)
    setPanelConfigValue(props.pkg, res.value)
    draft.value = snapshot(res.value)
    touched.value = []
    issues.value = []
    notice.value = "已恢复默认值"
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    saving.value = false
  }
}

watch(() => props.pkg, restart, { immediate: true })
</script>

<template>
  <div>
    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <template v-if="entry?.schema">
      <SchemaForm
        :schema="entry.schema"
        :value="draft"
        :issues="issues"
        :dirty="touched"
        @change="onChange"
      />

      <!--
        这段说明必须排在动作行**之前**：`config-actions` 在模态里常驻内容区底部
        （`styles.css` 的 `.sheet-body .config-actions`），排在它后面会被压住、只露半截。
      -->
      <p class="hint">
        值存在 webui 的数据目录下（<code>data/plugin/webui/panelconfig/</code>），不在包目录里，
        故「更新 webui」不会带走它。webui 只校验字段的类型与候选项，不校验取值范围。
      </p>

      <div class="row config-actions">
        <button class="primary" :disabled="!hasChanges || saving" @click="void save()">
          {{ saving ? "保存中…" : hasChanges ? `保存 ${touched.length} 处改动` : "无改动" }}
        </button>
        <button v-if="hasChanges" :disabled="saving" @click="restart()">放弃改动</button>
        <button class="danger" :disabled="saving" @click="void reset()">恢复默认值</button>
      </div>
    </template>
    <p v-else class="hint">这个包没有声明配置项。</p>
  </div>
</template>
