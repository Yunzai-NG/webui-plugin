<script setup lang="ts">
/**
 * 模块职责：群配置抽屉 —— 按账号与群的配置，以及可复用的规则组
 * 依赖方向：依赖 api / grouprules / scopereg / ChipInput / PickSelect / ScopeBodyFields / Modal / TabBar
 * 生命周期：配置页「消息」一栏点开；打开时读一次清单，选到某个账号时读它的群
 * 注意事项：**只存 `scope.rules` 与 `scope.presets`**：全局前缀与禁用在抽屉外面，随配置页那颗保存钮走。
 *          这两项整份一起写（见 grouprules.ts 文件头），保存后把新值交回配置页。
 *
 *          群列表要账号在线才取得到；不在线或旧内核时群号照样能手敲进去。
 */
import { computed, ref, watch } from "vue"
import { collapseHooks, onExpandDone, onExpandEnter, onExpandLeave, pinLeaving } from "../collapse.js"
import { get, patch } from "../api.js"
import { errorText } from "../format.js"
import {
  blankPreset,
  blankRule,
  bodyText,
  removePreset,
  renamePreset,
  scopeOf,
  type ScopeBody,
  type ScopeConfig,
  type ScopePreset,
  type ScopeRule
} from "../grouprules.js"
import { loadScopeLists } from "../scopereg.js"
import { showToast } from "../toast.js"
import type { AccountItem, CommandItem } from "../types.js"
import ChipInput, { type ChipOption } from "./ChipInput.vue"
import Modal from "./Modal.vue"
import PickSelect, { type PickOption } from "./PickSelect.vue"
import ScopeBodyFields from "./ScopeBodyFields.vue"
import TabBar from "./TabBar.vue"

const props = defineProps<{
  /** 是否打开 */
  open: boolean
  /** 配置页此刻的 `scope` 值（含尚未保存的全局前缀与禁用） */
  value: unknown
}>()

const emit = defineEmits<{
  /** 关闭 */
  close: []
  /** 保存成功，带上内核回的整份配置 */
  saved: [value: Record<string, unknown>]
}>()

const TABS = [
  { id: "rules", label: "群配置" },
  { id: "presets", label: "规则组" }
]
const tab = ref("rules")

const draft = ref<ScopeConfig>(scopeOf(undefined))
const dirty = ref(false)
const saving = ref(false)
const error = ref("")

const commands = ref<CommandItem[]>([])
const plugins = ref<string[]>([])
const scripts = ref<string[]>([])
const accounts = ref<AccountItem[]>([])
/** 账号记录 id → 它的群；取不到的记一句原因 */
const groups = ref<Map<string, { gid: string; name?: string }[] | string>>(new Map())

/**
 * 正在编辑的群配置：下标与草稿；新加的下标为 -1
 *
 * 「选几个群」「套用规则组」另记两个开关，不从 `groups` / `preset` 推：刚点到「选几个群」还没加群时，
 * 推出来又成了「全部群」，那一栏就点不进去。
 */
const editingRule = ref<{ at: number; rule: ScopeRule; some: boolean; usePreset: boolean } | undefined>(undefined)
/** 正在编辑的规则组：下标、原名与草稿 */
const editingPreset = ref<{ at: number; from: string; preset: ScopePreset } | undefined>(undefined)

/** 接受群配置的账号（适配器插件声明了 `groupRules`）：平台 id 去重 */
const accountRows = computed(() => {
  const seen = new Map<string, { id: string; label: string; recordId: string; online: boolean }>()
  for (const item of accounts.value) {
    const selfId = item.record.selfId
    if (selfId === undefined || selfId === "" || seen.has(selfId)) continue
    seen.set(selfId, {
      id: selfId,
      label: item.record.label === undefined ? selfId : `${item.record.label}（${selfId}）`,
      recordId: item.record.id,
      online: item.status === "online"
    })
  }
  return [...seen.values()]
})

/** 账号下拉 */
const accountOptions = computed<PickOption[]>(() => [
  { value: "*", label: "所有机器人", note: "接受群配置的那些" },
  ...accountRows.value.map(o => ({ value: o.id, label: o.label, ...(o.online ? {} : { note: "离线" }) }))
])

/** 规则组下拉 */
const presetOptions = computed<PickOption[]>(() => draft.value.presets.map(p => ({ value: p.name, label: p.name, note: bodyText(p, draft.value) })))

/**
 * 账号的显示名
 * @param id 平台 id 或 `*`
 * @returns 显示名
 */
function accountName(id: string): string {
  if (id === "*") return "所有机器人"
  return accountRows.value.find(o => o.id === id)?.label ?? id
}

/**
 * 某个账号的群列表；`*` 给所有账号的群之并
 * @param id 平台 id 或 `*`
 * @returns 群
 */
function groupsOf(id: string): { gid: string; name?: string }[] {
  const ids = id === "*" ? accountRows.value.map(o => o.recordId) : [accountRows.value.find(o => o.id === id)?.recordId ?? ""]
  const out = new Map<string, { gid: string; name?: string }>()
  for (const rid of ids) {
    const list = groups.value.get(rid)
    if (Array.isArray(list)) for (const g of list) if (!out.has(g.gid)) out.set(g.gid, g)
  }
  return [...out.values()]
}

/**
 * 取一个账号的群（取过就不再取）
 * @param id 平台 id 或 `*`
 */
async function loadGroups(id: string): Promise<void> {
  const targets = id === "*" ? accountRows.value : accountRows.value.filter(o => o.id === id)
  for (const o of targets) {
    if (groups.value.has(o.recordId)) continue
    let result: { gid: string; name?: string }[] | string
    if (!o.online) result = "账号不在线，取不到群列表"
    else {
      try {
        result = await get(`accounts/${encodeURIComponent(o.recordId)}/groups`)
      } catch (err) {
        result = `取不到群列表：${errorText(err)}`
      }
    }
    groups.value = new Map(groups.value).set(o.recordId, result)
  }
}

/** 群的候选：所选账号的群，加上已填而不在列表里的 */
const groupOptions = computed<ChipOption[]>(() => {
  const rule = editingRule.value?.rule
  if (rule === undefined) return []
  const list = groupsOf(rule.account)
  const known = new Set(list.map(g => g.gid))
  return [
    ...list.map(g => ({ value: g.gid, label: g.name ?? `群 ${g.gid}`, note: g.gid })),
    ...rule.groups.filter(gid => !known.has(gid)).map(gid => ({ value: gid, label: `群 ${gid}` }))
  ]
})

/** 所选账号取群时的问题 */
const groupProblem = computed(() => {
  const rule = editingRule.value?.rule
  if (rule === undefined) return ""
  if (rule.account === "*") return accountRows.value.length === 0 ? "没有接受群配置的账号，群号可以直接输入" : ""
  const rid = accountRows.value.find(o => o.id === rule.account)?.recordId
  const got = rid === undefined ? undefined : groups.value.get(rid)
  return typeof got === "string" ? `${got}；群号可以直接输入` : ""
})

/**
 * 一条群配置管哪些群，说成一句话
 * @param rule 群配置
 * @returns 文案
 */
function groupsText(rule: ScopeRule): string {
  if (rule.groups.length === 0) return rule.account === "*" ? "所有机器人的全部群" : "这个账号的全部群"
  const names = new Map(groupsOf(rule.account).map(g => [g.gid, g.name]))
  const shown = rule.groups.slice(0, 3).map(gid => names.get(gid) ?? gid)
  return `${shown.join("、")}${rule.groups.length > 3 ? ` 等 ${rule.groups.length} 个群` : ""}`
}

/**
 * 一条群配置用的是什么，说成一句话
 * @param rule 群配置
 * @returns 文案
 */
function sourceText(rule: ScopeRule): string {
  if (rule.preset !== "") {
    const found = draft.value.presets.find(p => p.name === rule.preset)
    return found === undefined ? `规则组「${rule.preset}」已不存在，按本条自己的设置` : `套用「${rule.preset}」：${bodyText(found, draft.value)}`
  }
  return bodyText(rule, draft.value)
}

/**
 * 编辑区展开完：上沿不在视野里时滚过去 —— 点的是列表靠下那条的「编辑」，编辑区出现在列表下面
 * @param el 编辑区
 */
function revealEdit(el: Element): void {
  onExpandDone(el)
  const box = el as HTMLElement
  const scroller = box.closest(".sheet-body")
  if (scroller === null) return
  const top = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  if (top < 0 || top > scroller.clientHeight * 0.6) {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    scroller.scrollTo({ top: scroller.scrollTop + top - 12, behavior: smooth ? "smooth" : "auto" })
  }
}

/** 读清单 */
async function load(): Promise<void> {
  error.value = ""
  try {
    const lists = await loadScopeLists()
    commands.value = lists.commands
    plugins.value = lists.plugins
    scripts.value = lists.scripts
    accounts.value = lists.accounts
  } catch (err) {
    error.value = errorText(err)
  }
}

/**
 * 开始编辑一条群配置
 * @param at 下标；-1 为新加
 */
function editRule(at: number): void {
  editingPreset.value = undefined
  const source = at < 0 ? blankRule(accountRows.value[0]?.id ?? "*") : draft.value.rules[at]
  if (source === undefined) return
  editingRule.value = {
    at,
    rule: { ...source, groups: [...source.groups], prefix: [...source.prefix], disabled: [...source.disabled] },
    some: source.groups.length > 0,
    usePreset: source.preset !== ""
  }
}

/** 收下正在编辑的群配置 */
function commitRule(): void {
  const editing = editingRule.value
  if (editing === undefined) return
  if (editing.some && editing.rule.groups.length === 0) {
    error.value = "选了「选几个群」就至少加一个群；要管全部群请选「全部群」"
    return
  }
  error.value = ""
  const rule = { ...editing.rule, groups: editing.some ? editing.rule.groups : [], preset: editing.usePreset ? editing.rule.preset : "" }
  const rules = [...draft.value.rules]
  if (editing.at < 0) rules.push(rule)
  else rules[editing.at] = rule
  draft.value = { ...draft.value, rules }
  editingRule.value = undefined
  dirty.value = true
}

/**
 * 删一条群配置
 * @param at 下标
 */
function dropRule(at: number): void {
  draft.value = { ...draft.value, rules: draft.value.rules.filter((_, i) => i !== at) }
  if (editingRule.value?.at === at) editingRule.value = undefined
  dirty.value = true
}

/**
 * 开始编辑一个规则组
 * @param at 下标；-1 为新加
 */
function editPreset(at: number): void {
  editingRule.value = undefined
  const source = at < 0 ? blankPreset(draft.value) : draft.value.presets[at]
  if (source === undefined) return
  editingPreset.value = { at, from: source.name, preset: { ...source, prefix: [...source.prefix], disabled: [...source.disabled] } }
}

/** 收下正在编辑的规则组 */
function commitPreset(): void {
  const editing = editingPreset.value
  if (editing === undefined) return
  const name = editing.preset.name.trim()
  if (name === "") return
  if (draft.value.presets.some((p, i) => p.name === name && i !== editing.at)) {
    error.value = `已有名为「${name}」的规则组`
    return
  }
  let next = draft.value
  if (editing.at >= 0 && editing.from !== name) next = renamePreset(next, editing.from, name)
  const presets = [...next.presets]
  const value = { ...editing.preset, name }
  if (editing.at < 0) presets.push(value)
  else presets[editing.at] = value
  draft.value = { ...next, presets }
  editingPreset.value = undefined
  error.value = ""
  dirty.value = true
}

/**
 * 删一个规则组
 * @param name 规则组名
 */
function dropPreset(name: string): void {
  draft.value = removePreset(draft.value, name)
  if (editingPreset.value?.from === name) editingPreset.value = undefined
  dirty.value = true
}

/**
 * 有几条群配置在用某个规则组
 * @param name 规则组名
 * @returns 条数
 */
function usersOf(name: string): number {
  return draft.value.rules.filter(r => r.preset === name).length
}

/** 保存群配置与规则组 */
async function save(): Promise<void> {
  saving.value = true
  error.value = ""
  try {
    const res = await patch<{ value: Record<string, unknown> }>("config/yunzai", {
      scope: { rules: draft.value.rules, presets: draft.value.presets }
    })
    dirty.value = false
    emit("saved", res.value)
    showToast("群配置已保存，下一条消息即按新规则处理")
  } catch (err) {
    error.value = errorText(err)
  } finally {
    saving.value = false
  }
}

/**
 * 改编辑中那条群配置的前缀与禁用
 * @param body 新的那一套
 */
function setRuleBody(body: ScopeBody): void {
  if (editingRule.value !== undefined) editingRule.value.rule = { ...editingRule.value.rule, ...body }
}

/**
 * 改编辑中那个规则组的前缀与禁用
 * @param body 新的那一套
 */
function setPresetBody(body: ScopeBody): void {
  if (editingPreset.value !== undefined) editingPreset.value.preset = { ...editingPreset.value.preset, ...body }
}

watch(
  () => props.open,
  open => {
    if (!open) return
    draft.value = scopeOf(props.value)
    dirty.value = false
    editingRule.value = undefined
    editingPreset.value = undefined
    void load()
  },
  { immediate: true }
)

// 全局前缀在抽屉外面可能刚改过，摘要里「沿用全局」要跟着
watch(
  () => props.value,
  value => {
    const outer = scopeOf(value)
    draft.value = { ...draft.value, prefix: outer.prefix, disabled: outer.disabled }
  },
  { deep: true }
)

watch(
  () => editingRule.value?.rule.account,
  id => {
    if (id !== undefined) void loadGroups(id)
  }
)

watch(accountRows, rows => {
  if (rows.length > 0 && editingRule.value !== undefined) void loadGroups(editingRule.value.rule.account)
})
</script>

<template>
  <Modal :open="open" side title="群配置" sub="按账号与群设前缀、禁用插件或命令，优先于全局；私聊不受影响" @close="emit('close')">
    <p v-if="error" class="banner">{{ error }}</p>
    <TabBar v-model="tab" :items="TABS" label="群配置分区" />

    <Transition name="swap" mode="out-in">
      <!-- ── 群配置 ── -->
      <section v-if="tab === 'rules'" key="rules" class="scope-pane">
        <p class="hint">一个群落进几条配置时：写了群号的优先于「全部群」，指名账号的优先于「所有机器人」，同一档里靠后的优先。</p>
        <p v-if="accountRows.length === 0" class="banner warn">
          没有接受群配置的机器人账号。适配器插件声明 <code>groupRules: true</code> 后，它接入的机器人才出现在这里
          （adapter-onebot 0.7.1 起已声明）；没声明的适配器名下的机器人在群里照常收发，不受群配置约束。
        </p>
        <TransitionGroup name="rowfx" tag="ul" class="scope-list" @before-leave="pinLeaving">
          <li v-for="(rule, i) in draft.rules" :key="`${rule.account}/${rule.groups.join(',')}/${i}`" class="scope-card" :class="{ on: editingRule?.at === i }">
            <div class="scope-card-main">
              <b>{{ accountName(rule.account) }}</b>
              <span>{{ groupsText(rule) }}</span>
              <span class="hint">{{ sourceText(rule) }}</span>
            </div>
            <div class="row">
              <button :disabled="editingRule?.at === i" @click="editRule(i)">编辑</button>
              <button class="danger" @click="dropRule(i)">删除</button>
            </div>
          </li>
        </TransitionGroup>
        <p v-if="draft.rules.length === 0 && editingRule === undefined" class="scope-empty hint">还没有群配置，所有群都按配置页上的全局前缀与禁用走。</p>
        <button v-if="editingRule === undefined" class="primary scope-add" @click="editRule(-1)">添加群配置</button>

        <Transition name="expand" @enter="onExpandEnter" @after-enter="revealEdit" @leave="onExpandLeave">
          <div v-if="editingRule" :key="editingRule.at" class="scope-edit">
            <div class="scope-edit-in">
              <h3>{{ editingRule.at < 0 ? "添加群配置" : "编辑群配置" }}</h3>
              <div class="sc-field">
                <span class="s-label">机器人账号</span>
                <PickSelect id="sc-account" v-model="editingRule.rule.account" :options="accountOptions" label="机器人账号" />
              </div>

              <div class="sc-field">
                <span class="s-label">管哪些群</span>
                <div class="seg" role="radiogroup" aria-label="管哪些群">
                  <label><input v-model="editingRule.some" type="radio" :value="false" name="sc-groups" /><span>全部群</span></label>
                  <label><input v-model="editingRule.some" type="radio" :value="true" name="sc-groups" /><span>选几个群</span></label>
                </div>
                <Transition name="expand" v-on="collapseHooks">
                  <div v-if="editingRule.some" class="sc-reveal">
                    <ChipInput v-model="editingRule.rule.groups" :options="groupOptions" label="群" placeholder="还没选群" free />
                    <p v-if="groupProblem" class="hint">{{ groupProblem }}</p>
                  </div>
                </Transition>
              </div>

              <div class="sc-field">
                <span class="s-label">用什么规则</span>
                <div class="seg" role="radiogroup" aria-label="用什么规则">
                  <label><input v-model="editingRule.usePreset" type="radio" :value="false" name="sc-source" /><span>自定义</span></label>
                  <label :title="draft.presets.length === 0 ? '先到「规则组」里建一个' : ''">
                    <input
                      v-model="editingRule.usePreset"
                      type="radio"
                      :value="true"
                      name="sc-source"
                      :disabled="draft.presets.length === 0"
                      @change="editingRule.rule.preset === '' && (editingRule.rule.preset = draft.presets[0]?.name ?? '')"
                    /><span>套用规则组</span>
                  </label>
                </div>
                <p v-if="draft.presets.length === 0" class="hint">还没有规则组，到「规则组」页签里建一个就能套用。</p>
              </div>

              <Transition name="swap" mode="out-in">
                <div v-if="editingRule.usePreset" key="preset" class="sc-field">
                  <span class="s-label">规则组</span>
                  <PickSelect v-model="editingRule.rule.preset" :options="presetOptions" label="规则组" />
                </div>
                <ScopeBodyFields
                  v-else
                  key="own"
                  :model-value="editingRule.rule"
                  :commands="commands"
                  :plugins="plugins"
                  :scripts="scripts"
                  :global-prefix="draft.prefix"
                  id-base="sc-rule"
                  @update:model-value="setRuleBody"
                />
              </Transition>

              <div class="row scope-edit-foot">
                <button class="primary" @click="commitRule()">确定</button>
                <button @click="editingRule = undefined">取消</button>
              </div>
            </div>
          </div>
        </Transition>
      </section>

      <!-- ── 规则组 ── -->
      <section v-else key="presets" class="scope-pane">
        <p class="hint">起好名字的一套前缀与禁用。群配置里选「套用规则组」即整套用上；改了规则组，用它的群一并跟着变。</p>
        <TransitionGroup name="rowfx" tag="ul" class="scope-list" @before-leave="pinLeaving">
          <li v-for="(p, i) in draft.presets" :key="p.name" class="scope-card" :class="{ on: editingPreset?.at === i }">
            <div class="scope-card-main">
              <b>{{ p.name }}</b>
              <span class="hint">{{ bodyText(p, draft) }} · {{ usersOf(p.name) }} 条群配置在用</span>
            </div>
            <div class="row">
              <button :disabled="editingPreset?.at === i" @click="editPreset(i)">编辑</button>
              <button class="danger" :title="usersOf(p.name) > 0 ? '用它的群配置会改成它当时的设置，效果不变' : ''" @click="dropPreset(p.name)">删除</button>
            </div>
          </li>
        </TransitionGroup>
        <p v-if="draft.presets.length === 0 && editingPreset === undefined" class="scope-empty hint">还没有规则组。</p>
        <button v-if="editingPreset === undefined" class="primary scope-add" @click="editPreset(-1)">新建规则组</button>

        <Transition name="expand" @enter="onExpandEnter" @after-enter="revealEdit" @leave="onExpandLeave">
          <div v-if="editingPreset" :key="editingPreset.at" class="scope-edit">
            <div class="scope-edit-in">
              <h3>{{ editingPreset.at < 0 ? "新建规则组" : "编辑规则组" }}</h3>
              <div class="sc-field">
                <label class="s-label" for="sc-pname">名字</label>
                <input id="sc-pname" v-model="editingPreset.preset.name" placeholder="如 组1" />
              </div>
              <ScopeBodyFields
                :model-value="editingPreset.preset"
                :commands="commands"
                :plugins="plugins"
                :scripts="scripts"
                :global-prefix="draft.prefix"
                id-base="sc-preset"
                @update:model-value="setPresetBody"
              />
              <div class="row scope-edit-foot">
                <button class="primary" :disabled="editingPreset.preset.name.trim() === ''" @click="commitPreset()">确定</button>
                <button @click="editingPreset = undefined">取消</button>
              </div>
            </div>
          </div>
        </Transition>
      </section>
    </Transition>
    <template #actions>
      <span v-if="dirty || editingRule || editingPreset" class="hint">
        {{ editingRule || editingPreset ? "先点「确定」收下正在编辑的那条，再保存" : "有未保存的改动" }}
      </span>
      <button @click="emit('close')">关闭</button>
      <button class="primary" :disabled="saving || !dirty || editingRule !== undefined || editingPreset !== undefined" @click="void save()">
        {{ saving ? "保存中…" : "保存" }}
      </button>
    </template>
  </Modal>
</template>
