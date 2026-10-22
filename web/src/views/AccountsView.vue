<script setup lang="ts">
/**
 * 模块职责：账号页 —— 按适配器分页签，每枚页签下是该适配器的账号；添加、改配置都在弹窗里
 * 依赖方向：依赖 api / accountview / format / retry / toast 与 SchemaForm、LoginSession 等组件
 * 生命周期：挂载时拉取一次；存在进行中的登录会话时按秒轮询
 * 注意事项：添加账号两条路径，取决于适配器声明的能力：声明了 `loginModes` 的走交互式登录（会话由
 *          内核驱动，面板只渲染 steps 并回送 prompt 答案），未声明者手工填配置、表单由
 *          `accountSchema` 驱动。两条路径都在「添加账号」弹窗里，适配器就是当前页签那个。
 *
 *          登录会话用轮询而非 WebSocket：一次扫码只存续数分钟、状态变化不足十次，推送通道要多一个
 *          端点与一套重连逻辑。轮询只在存在进行中的会话时启用（见 `syncLogins`），空闲时无定时器。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue"
import { useAction } from "../action.js"
import { del, get, patch, post } from "../api.js"
import { accountTabsOf, accountsOfTab, loginStepOf, loginsOfTab, ORPHAN_TAB, pickAccountTab } from "../accountview.js"
import { defaultsOf, snapshot } from "../configedit.js"
import { errorText, statusClass, statusText } from "../format.js"
import { ICONS } from "../icons.js"
import { globalRetryOf, isRetryCustom, retryCountOf, retryFormOf, retryOverrideOf, retrySummary } from "../retry.js"
import { askConfirm } from "../confirm.js"
import { currentQuery, hrefOf } from "../router.js"
import { showToast } from "../toast.js"
import EmptyState from "../components/EmptyState.vue"
import LoginSession from "../components/LoginSession.vue"
import Modal from "../components/Modal.vue"
import PageHeader from "../components/PageHeader.vue"
import RetryFields from "../components/RetryFields.vue"
import StepBar from "../components/StepBar.vue"
import SchemaForm from "../components/SchemaForm.vue"
import TabBar from "../components/TabBar.vue"
import { ApiError } from "../api.js"
import type { GlobalRetry, RetryForm } from "../retry.js"
import type { AccountItem, AdapterSummary, ConfigDetail, LoginSnapshot, SchemaIssue } from "../types.js"

/** 存在进行中的会话时的轮询间隔 */
const POLL_MS = 1000

/** 内核配置名，与内核 `CORE_CONFIG_NAME` 一致（对应 `config/yunzai.yaml`） */
const CORE_CONFIG = "yunzai"

const adapters = ref<AdapterSummary[]>([])
const accounts = ref<AccountItem[]>([])
const logins = ref<LoginSnapshot[]>([])
/** 首次拉取是否已回来；之前不画「还没有适配器」，免得一闪 */
const loaded = ref(false)
const { error, busy, run } = useAction()

/* ─────────────── 页签 ─────────────── */

const tabs = computed(() => accountTabsOf(adapters.value, accounts.value))

/**
 * 当前页签
 *
 * 地址里的 `?adapter=` 在适配器表回来之前对不上任何一枚，故先记下它、等表回来再认；
 * 直接拿来初始化 `tab` 的话第一帧就被「对不上、退回第一枚」改掉了。
 */
const wantedTab = currentQuery.value.adapter
const tab = ref("")
watch(tabs, list => {
  if (list.some(t => t.id === tab.value)) return
  tab.value = pickAccountTab(list, tab.value === "" ? wantedTab : undefined)
})
watch(tab, id => {
  if (id !== "") history.replaceState(null, "", hrefOf("accounts", { adapter: id }))
})

/** 当前页签的适配器；「未注册」那枚没有 */
const adapter = computed(() => adapters.value.find(a => a.id === tab.value))
/** 当前页签下的账号 */
const tabAccounts = computed(() => accountsOfTab(tab.value, adapters.value, accounts.value))
/** 当前页签下的登录会话 */
const tabLogins = computed(() => loginsOfTab(tab.value, logins.value))

/**
 * 登录方式的显示名
 * @param session 会话
 * @returns 名字；适配器已不在时 undefined
 */
function modeNameOf(session: LoginSnapshot): string | undefined {
  return adapters.value.find(a => a.id === session.adapterId)?.loginModes?.find(m => m.id === session.mode)?.name
}

/* ─────────────── 添加账号（弹窗） ─────────────── */

/**
 * 弹窗正在给哪个适配器加号；关着时 undefined
 *
 * 打开那一刻就定下，不跟着当前页签走：弹窗开着时列表照常每秒轮询，页签表也会跟着重算。
 */
const adding = ref<AdapterSummary | undefined>(undefined)
/** 新建账号的配置值 */
const draftConfig = ref<Record<string, unknown>>({})
/** 新建账号的备注 */
const draftLabel = ref("")
/** 新建账号的逐字段错误 */
const draftIssues = ref<readonly SchemaIssue[]>([])
/**
 * 新建账号的重连覆盖，四项皆以字符串存 —— 空串即「跟随全局」
 *
 * 建号时一次 `create()` 填好，不建完再 PATCH：后者会因 `config` 到达而断开重连，
 * 一个刚接上的号先闪一次离线。与 `draftConfig` 分开的理由同 `editRetry`。
 */
const draftRetry = ref<RetryForm>(retryFormOf(undefined))
/** 弹窗里发起的那个登录会话 */
const addSessionId = ref("")
/** 弹窗内的错误，只显示在弹窗里 —— 页顶那条此刻被遮住 */
const addError = ref("")
/**
 * 手工填写那张表单是否展开
 *
 * 适配器支持交互式登录时默认收起：扫码比手抄凭据少出错，表单摆在下面只会让人以为两样都要填。
 */
const manualOpen = ref(false)

/** 弹窗里那个会话的最新快照；还没发起、或内核已把它清掉时 undefined */
const addSession = computed(() =>
  addSessionId.value === "" ? undefined : logins.value.find(s => s.id === addSessionId.value)
)

/** 弹窗里的适配器支持交互式登录吗 */
const addHasLogin = computed(() => (adding.value?.loginModes ?? []).length > 0)

/**
 * 打开添加账号的弹窗
 * @param target 适配器
 */
function openAdd(target: AdapterSummary): void {
  adding.value = target
  draftConfig.value = defaultsOf(target.accountSchema)
  draftLabel.value = ""
  draftIssues.value = []
  draftRetry.value = retryFormOf(undefined)
  addSessionId.value = ""
  addError.value = ""
  manualOpen.value = (target.loginModes ?? []).length === 0
}

/** 关掉弹窗。进行中的会话不取消，关掉之后仍在页签下显示，可以接着扫 */
function closeAdd(): void {
  adding.value = undefined
  addSessionId.value = ""
  addError.value = ""
}

// 弹窗里的会话成功了：建出了账号，关窗、报一声、刷新列表
watch(
  () => addSession.value?.status,
  status => {
    if (status !== "done") return
    const name = adding.value?.name ?? ""
    closeAdd()
    showToast(`已通过登录接入一个 ${name} 账号`)
    void refreshAccounts()
  }
)

/**
 * 记录一项新建表单的改动
 * @param path 点号路径
 * @param value 新值
 */
function onDraftChange(path: string, value: unknown): void {
  setPath(draftConfig.value, path, value)
}

/**
 * 依据手工填写的配置创建账号
 *
 * **四项全空即不送 `retry`**（而非像编辑那样送 `null`）：`null` 的意思是「清掉已有的覆盖」，
 * 而一个还不存在的账号没有覆盖可清。
 */
async function createAccount(): Promise<void> {
  const target = adding.value
  if (target === undefined) return
  busy.value = "new"
  draftIssues.value = []
  addError.value = ""
  try {
    const retry = retryOverrideOf(draftRetry.value)
    await post("accounts", {
      adapterId: target.id,
      config: draftConfig.value,
      ...(draftLabel.value === "" ? {} : { label: draftLabel.value }),
      ...(retry === null ? {} : { retry })
    })
    closeAdd()
    showToast(`已添加 ${target.name} 账号，正在连接`)
    await refreshAccounts()
  } catch (err) {
    if (err instanceof ApiError && err.issues.length > 0) draftIssues.value = err.issues
    addError.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 在弹窗里发起一个交互式登录会话
 * @param mode 登录方式 id
 */
async function startLogin(mode: string): Promise<void> {
  const target = adding.value
  if (target === undefined) return
  busy.value = "login"
  addError.value = ""
  try {
    const session = await post<LoginSnapshot>("logins", {
      adapterId: target.id,
      mode,
      ...(draftLabel.value === "" ? {} : { label: draftLabel.value })
    })
    addSessionId.value = session.id
    await syncLogins()
  } catch (err) {
    addError.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 回答弹窗里那个会话的提问
 * @param value 答案
 */
function answerAdd(value: unknown): void {
  if (addSession.value !== undefined) void answer(addSession.value.id, value)
}

/** 取消弹窗里那个会话 */
function cancelAdd(): void {
  if (addSession.value !== undefined) void cancelLogin(addSession.value.id)
}

/** 弹窗里的会话失败或取消了：回到选登录方式那一步 */
function retryLogin(): void {
  addSessionId.value = ""
  addError.value = ""
}

/* ─────────────── 拉取与轮询 ─────────────── */

let timer: number | undefined

/** 拉取账号与适配器 */
async function load(): Promise<void> {
  try {
    const [a, acc] = await Promise.all([get<AdapterSummary[]>("adapters"), get<AccountItem[]>("accounts")])
    adapters.value = a
    accounts.value = acc
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  }
  loaded.value = true
  await loadGlobalRetry()
  await syncLogins()
}

/**
 * 取全局重连四项
 *
 * 只留这四个数，整份内核配置不在这一页落地：`GET config/:name` 刻意不脱敏，响应体里带着
 * `server.token`。挑取在 `globalRetryOf` 里。失败即静默 —— 只是让「跟随全局」少一个
 * 括号里的数，不该盖掉账号列表拉取失败那条更要紧的错误。
 */
async function loadGlobalRetry(): Promise<void> {
  try {
    const detail = await get<ConfigDetail>(`config/${encodeURIComponent(CORE_CONFIG)}`)
    globalRetry.value = globalRetryOf(detail.value)
  } catch {
    globalRetry.value = {}
  }
}

/**
 * 拉取登录会话，并据此决定是否继续轮询
 *
 * 定时器由本函数独占管理：会话一结束就停，否则面板在后台每秒请求内核一次。
 */
async function syncLogins(): Promise<void> {
  try {
    logins.value = await get<LoginSnapshot[]>("logins")
  } catch {
    // 静默：这一份失败不该盖掉页面上更要紧的错误（如账号列表读取失败）
  }
  // 等待用户输入时状态仍是 `running`（内核没有独立的等待状态），故只判这一个值即可
  const active = logins.value.some(s => s.status === "running")
  if (active && timer === undefined) {
    timer = window.setInterval(() => void syncLogins(), POLL_MS)
  } else if (!active && timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
    // 会话刚结束：成功的会话将创建出账号，须重新拉取列表方可显示
    await refreshAccounts()
  }
}

/** 仅重新拉取账号列表 */
async function refreshAccounts(): Promise<void> {
  try {
    accounts.value = await get<AccountItem[]>("accounts")
  } catch (err) {
    error.value = errorText(err)
  }
}

/**
 * 回答一个会话当前的提问
 * @param id 会话 id
 * @param value 答案；确认型传布尔
 */
async function answer(id: string, value: unknown): Promise<void> {
  const pending = logins.value.find(s => s.id === id)?.pending
  if (pending === undefined) return
  await run(id, async () => {
    await post(`logins/${encodeURIComponent(id)}/answer`, { seq: pending.seq, value })
    await syncLogins()
  })
}

/**
 * 取消一个会话
 * @param id 会话 id
 */
async function cancelLogin(id: string): Promise<void> {
  try {
    await del(`logins/${encodeURIComponent(id)}`)
    await syncLogins()
  } catch (err) {
    error.value = errorText(err)
  }
}

/* ─────────────── 列表上的操作 ─────────────── */

/**
 * 对某个账号执行动作
 * @param id 账号 id
 * @param action 动作
 */
async function act(id: string, action: "connect" | "disconnect" | "reconnect"): Promise<void> {
  await run(id, async () => {
    // 端点返回动作执行后的状态，就地替换该行即可，无须重新拉取整张表
    const next = await post<AccountItem | undefined>(`accounts/${encodeURIComponent(id)}/${action}`)
    if (next !== undefined) accounts.value = accounts.value.map(a => (a.record.id === id ? next : a))
  })
}

/**
 * 删除一个账号
 * @param id 账号 id
 * @param label 展示名，用于确认框
 */
async function remove(id: string, label: string): Promise<void> {
  const ok = await askConfirm({
    title: `删除账号「${label}」？`,
    body: "连接会立即断开，该账号的配置一并移除。此操作不可撤销。",
    okText: "删除",
    danger: true
  })
  if (!ok) return
  await run(id, async () => {
    await del(`accounts/${encodeURIComponent(id)}`)
    accounts.value = accounts.value.filter(a => a.record.id !== id)
  })
}

/**
 * 切换启用状态
 * @param item 账号
 */
async function toggleEnabled(item: AccountItem): Promise<void> {
  await run(item.record.id, async () => {
    const next = await patch<AccountItem>(`accounts/${encodeURIComponent(item.record.id)}`, {
      enabled: !item.record.enabled
    })
    accounts.value = accounts.value.map(a => (a.record.id === item.record.id ? next : a))
  })
}

/* ─────────────── 改已有账号的配置 ─────────────── */

/**
 * 正在编辑配置的账号；未在编辑时 undefined
 *
 * 存整条记录而非只存 id：模态标题要显示备注与适配器名，而列表每秒轮询一次刷新
 * （见 `POLL_MS`）—— 只存 id 的话每次轮询都要在新数组里重查一遍，那个账号在
 * 编辑期间被删掉时还会取到 undefined。
 */
const editing = ref<AccountItem | undefined>(undefined)
/** 编辑中的配置值，`editing` 打开时按该账号现有配置铺好 */
const editConfig = ref<Record<string, unknown>>({})
/** 编辑中的备注 */
const editLabel = ref("")
/**
 * 编辑中的重连覆盖，四项皆以字符串存 —— 空串即「跟随全局」
 *
 * 与 `editConfig` 分开的理由和内核把 `retry` 放在 `config` 之外一样：这四项归内核所有，
 * 适配器不参与，故适配器插件被卸载、画不出配置表单时，它们照旧可改。
 */
const editRetry = ref<RetryForm>(retryFormOf(undefined))
/** 编辑保存时的逐字段错误 */
const editIssues = ref<readonly SchemaIssue[]>([])
/** 编辑保存失败的原因，只显示在模态内 —— 页顶那条使用者此刻看不到 */
const editError = ref("")

/** 全局重连四项，只为把「跟随全局」说成一个具体的数；读不到时为空对象 */
const globalRetry = ref<GlobalRetry>({})

/**
 * 表单末尾那枚「重连策略」页签
 *
 * 它不在适配器的 schema 里（四项归内核所有，见 RetryFields 文件头），却和「常规」「传输」一样是
 * 这个号的一组设置，故排在它们后面自成一栏，而不是压在表单底下要往下翻才看得到。
 * 角标是填了几项覆盖。内核眼下对 `retry` 只报一句整体的 400（落在弹窗顶部那条），
 * 将来若按字段给出 `retry.*` 的 issues，会归到这一栏。
 * @param form 表单态
 * @returns 额外页签
 */
function retryTabOf(form: RetryForm): { id: string; label: string; count?: number; issuePrefix: string }[] {
  const count = retryCountOf(form)
  return [{ id: "retry", label: "重连策略", issuePrefix: "retry", ...(count > 0 ? { count } : {}) }]
}

/**
 * 正在编辑的那个账号所属适配器
 *
 * 表单要靠它的 `accountSchema` 渲染。**取不到时不画表单**（见模板）：适配器插件被卸载之后
 * 它名下的账号记录仍在（那是有意的，装回来就能自动连上），此时没有 schema 可依，
 * 画一张空表单再保存等于把配置清空。
 */
const editAdapter = computed(() =>
  editing.value === undefined ? undefined : adapters.value.find(a => a.id === editing.value?.record.adapterId)
)

/** 编辑表单要用的 schema；适配器不在（插件已卸载）时 undefined */
const editSchema = computed(() => editAdapter.value?.accountSchema)

/**
 * 这次编辑动过适配器配置吗
 *
 * 判它是为了不为一次只改重连策略的保存踢掉一个在线的号：内核收到 `config` 就断开重连，
 * 而 `label` 与 `retry` 不参与建连，那侧专留了「只动这两项就不动连接」的路。
 *
 * 比 JSON 文本而非深比对，且宁可多判成变了 —— 多一次重连是小事，漏判则是「改了地址却没重连」。
 */
const configChanged = computed(() => {
  const before = editing.value?.record.config
  if (before === undefined) return false
  return JSON.stringify(before) !== JSON.stringify(editConfig.value)
})

/**
 * 打开编辑框
 *
 * 深拷一份再改，**不直接改 `item.record.config`**：那个对象来自列表，直接改的话使用者点「取消」
 * 之后表格里显示的已经是改过的值，而服务端上并没有变 —— 一次没保存的编辑就此变成了假象。
 * @param item 账号
 */
function openEdit(item: AccountItem): void {
  editing.value = item
  // 用 `snapshot`（JSON 往返）而非 `structuredClone`：后者克隆 Vue 响应式代理会抛
  // DataCloneError，且抛在模态已打开之后 —— 表现为「点配置，配置项全是空的」，一保存
  // 就把这个号的地址与凭据清空
  editConfig.value = snapshot(item.record.config)
  editLabel.value = item.record.label ?? ""
  editRetry.value = retryFormOf(item.record.retry)
  editIssues.value = []
  editError.value = ""
}

/** 关掉编辑框 */
function closeEdit(): void {
  editing.value = undefined
  editConfig.value = {}
  editRetry.value = retryFormOf(undefined)
  editIssues.value = []
  editError.value = ""
}

/**
 * 记录一项编辑表单的改动
 * @param path 点号路径
 * @param value 新值
 */
function onEditChange(path: string, value: unknown): void {
  setPath(editConfig.value, path, value)
}

/**
 * 按点号路径写进一份配置，沿途缺的层级补成空对象
 * @param target 配置
 * @param path 点号路径
 * @param value 新值
 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".")
  const leaf = parts.pop()
  if (leaf === undefined) return
  let node = target
  for (const part of parts) {
    const existing = node[part]
    if (typeof existing !== "object" || existing === null) node[part] = {}
    node = node[part] as Record<string, unknown>
  }
  node[leaf] = value
}

/**
 * 保存改动
 *
 * `config` 只在真的改过时才送（见 `configChanged`）：内核收到它就断开并重连，而只改备注或
 * 重连策略的保存不该让一个在线的号掉线。`retry` 一律送 —— 填了至少一项即送对象，四项全空
 * 送 `null`（清掉覆盖、回到跟随全局）。
 */
async function saveEdit(): Promise<void> {
  const item = editing.value
  if (item === undefined) return
  busy.value = item.record.id
  editIssues.value = []
  try {
    const body: Record<string, unknown> = {
      label: editLabel.value.trim(),
      retry: retryOverrideOf(editRetry.value)
    }
    if (configChanged.value) body.config = editConfig.value
    await patch<AccountItem>(`accounts/${encodeURIComponent(item.record.id)}`, body)
    closeEdit()
    error.value = ""
    await refreshAccounts()
  } catch (err) {
    // 逐字段的错误标回表单里，而不是只在顶部显示一句 —— 一份十几项的配置里
    // 「哪一项填错了」是使用者真正需要的那半句话
    if (err instanceof ApiError && err.issues.length > 0) editIssues.value = err.issues
    editError.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

onMounted(() => void load())
onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer)
})
</script>

<template>
  <div>
    <PageHeader
      route="accounts"
      sub="账号由适配器插件接入，登录流程同样来自插件 —— 内核本身不感知任何平台"
    />

    <p v-if="error" class="banner">{{ error }}</p>

    <div v-if="loaded && tabs.length === 0" class="card">
      <EmptyState
        :icon="ICONS.layers"
        title="还没有可用的适配器"
        hint="账号要由适配器插件接入。先在插件市场装一个（如 adapter-onebot），在插件页确认已加载后，这里会按适配器分出页签。"
      >
        <a class="button primary" :href="hrefOf('market')">去插件市场</a>
      </EmptyState>
    </div>

    <template v-else-if="tabs.length > 0">
      <TabBar v-model="tab" :items="tabs" label="适配器" />

      <!-- 换页签时淡入淡出，与外观页、商店的页签同一套过渡；轮询刷新不换 key，故不会跟着闪 -->
      <Transition name="tab" mode="out-in">
      <section :key="tab" class="card acc-panel" role="tabpanel">
        <header class="acc-head">
          <div class="acc-title">
            <template v-if="adapter">
              <h2>{{ adapter.name }}</h2>
              <span class="tag mono">{{ adapter.platform }}</span>
              <span v-if="(adapter.loginModes ?? []).length > 0" class="tag">支持交互式登录</span>
            </template>
            <h2 v-else>未注册的适配器</h2>
          </div>
          <button v-if="adapter" class="primary" @click="openAdd(adapter)">添加账号</button>
        </header>
        <p v-if="adapter?.description" class="hint">{{ adapter.description }}</p>
        <p v-if="tab === ORPHAN_TAB" class="hint">
          这些账号所属的适配器插件当前没有加载（未装或已卸载）。账号记录照旧保留，装回那个插件后会自动连上；
          不再需要的可以在这里删掉。
        </p>

        <!-- 关掉添加弹窗时仍在进行的会话：可以接着扫码或回答 -->
        <div v-for="session in tabLogins" :key="session.id" class="acc-login">
          <LoginSession
            :session="session"
            :mode-name="modeNameOf(session)"
            :busy="busy === session.id"
            @answer="value => void answer(session.id, value)"
            @cancel="void cancelLogin(session.id)"
          />
          <p v-if="session.accountId" class="hint">已创建账号 {{ session.accountId }}</p>
        </div>

        <table v-if="tabAccounts.length > 0" class="rows">
          <thead>
            <tr>
              <th>账号</th>
              <th>状态</th>
              <th>启用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in tabAccounts" :key="item.record.id">
              <td data-label="账号">
                <b>{{ item.record.label ?? item.record.selfId ?? item.record.id }}</b>
                <p class="hint mono">
                  {{ item.record.id }}<template v-if="tab === ORPHAN_TAB"> · {{ item.record.adapterId }}</template>
                </p>
              </td>
              <td data-label="状态">
                <span class="tag" :class="statusClass(item.status)">{{ statusText(item.status) }}</span>
                <span v-if="item.retries > 0" class="tag warn">重试 {{ item.retries }} 次</span>
                <p v-if="item.error" class="err">{{ item.error }}</p>
                <!--
                  自定义重连策略要在列表上留下痕迹

                  它是一条看不见的状态，而「这个号为什么不再重试了」的答案往往就在里面 ——
                  只在编辑框里才看得到的话，排查要先点开每个账号。
                -->
                <p v-if="isRetryCustom(item.record.retry)" class="hint">
                  重连策略：{{ retrySummary(item.record.retry) }}
                </p>
              </td>
              <td data-label="启用">
                <label class="switch">
                  <input
                    type="checkbox"
                    :checked="item.record.enabled"
                    :disabled="busy === item.record.id"
                    :aria-label="`启用 ${item.record.label ?? item.record.id}`"
                    @change="void toggleEnabled(item)"
                  />
                  <span class="switch-track"></span>
                </label>
              </td>
              <td data-label="操作">
                <div class="row">
                  <button
                    v-if="item.status !== 'online'"
                    :disabled="busy === item.record.id"
                    @click="void act(item.record.id, 'connect')"
                  >
                    连接
                  </button>
                  <button v-else :disabled="busy === item.record.id" @click="void act(item.record.id, 'disconnect')">
                    断开
                  </button>
                  <button :disabled="busy === item.record.id" @click="void act(item.record.id, 'reconnect')">重连</button>
                  <button :disabled="busy === item.record.id" @click="openEdit(item)">配置</button>
                  <button
                    class="danger"
                    :disabled="busy === item.record.id"
                    @click="void remove(item.record.id, item.record.label ?? item.record.id)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <EmptyState
          v-else-if="adapter && tabLogins.length === 0"
          :icon="ICONS.plus"
          :title="`还没有 ${adapter.name} 账号`"
          :hint="(adapter.loginModes ?? []).length > 0 ? '点「添加账号」，用它提供的登录方式接入，或手工填写配置。' : '点「添加账号」，按它需要的连接信息填一份配置。'"
        >
          <button class="primary" @click="openAdd(adapter)">添加账号</button>
        </EmptyState>
      </section>
      </Transition>
    </template>

    <!--
      ───── 添加账号 ─────

      适配器就是打开时所在的那枚页签，不再在弹窗里选。`wide`：表单是 `SchemaForm`，
      窄框里每个字段都要折行。
    -->
    <Modal
      :open="adding !== undefined"
      :title="`添加账号 · ${adding?.name ?? ''}`"
      :sub="adding?.description"
      wide
      @close="closeAdd()"
    >
      <p v-if="addError !== ''" class="banner">{{ addError }}</p>

      <!-- 只在交互式登录时有步骤可言；手工填写只有「填完、创建」一步 -->
      <StepBar v-if="addSession !== undefined || (addHasLogin && !manualOpen)" :steps="['选登录方式', '完成登录', '已接入']" :current="loginStepOf(addSession)" />

      <template v-if="addSession">
        <LoginSession
          :session="addSession"
          :mode-name="modeNameOf(addSession)"
          :busy="busy === addSession.id"
          @answer="answerAdd"
          @cancel="cancelAdd()"
        />
        <p v-if="addSession.status === 'running'" class="hint">
          关掉这个弹窗不会取消登录，它会留在页签下，可以接着完成。
        </p>
        <div v-else-if="addSession.status !== 'done'" class="row">
          <button @click="retryLogin()">换个方式重来</button>
        </div>
      </template>

      <template v-else>
        <div class="field">
          <label for="draftLabel">备注</label>
          <input id="draftLabel" v-model="draftLabel" placeholder="选填，用于在列表中区分多个账号" />
        </div>

        <!-- 提供交互式登录时优先呈现：手工填写凭据是最易出错的一步 -->
        <template v-if="addHasLogin">
          <p class="hint">该适配器支持交互式登录，建议用以下方式接入：</p>
          <div class="row acc-modes">
            <button
              v-for="mode in adding?.loginModes ?? []"
              :key="mode.id"
              class="primary"
              :disabled="busy === 'login'"
              @click="void startLogin(mode.id)"
            >
              {{ mode.name }}
            </button>
          </div>
          <button class="link acc-manual" type="button" :aria-expanded="manualOpen" @click="manualOpen = !manualOpen">
            {{ manualOpen ? "收起手工填写" : "或手工填写配置" }}
          </button>
        </template>

        <template v-if="manualOpen && adding">
          <!--
            重连策略在建号时就给出，而非建完再进一次配置框：内核的 `POST accounts` 本就收 `retry`，
            建完再 PATCH 会因 `config` 到达而断开重连。与「配置」弹窗里是同一个组件。
          -->
          <SchemaForm
            :schema="adding.accountSchema"
            :value="draftConfig"
            :issues="draftIssues"
            :extras="retryTabOf(draftRetry)"
            @change="onDraftChange"
          >
            <template #retry>
              <RetryFields v-model="draftRetry" :global="globalRetry" in-tab />
            </template>
          </SchemaForm>
        </template>
      </template>

      <template #actions>
        <button @click="closeAdd()">{{ addSession?.status === "running" ? "稍后再说" : "取消" }}</button>
        <button
          v-if="manualOpen && addSession === undefined"
          class="primary"
          :disabled="busy === 'new'"
          @click="void createAccount()"
        >
          创建账号
        </button>
      </template>
    </Modal>

    <!--
      ───── 改已有账号的配置 ─────

      做成模态而不是在表格里展开一行：一份账号配置动辄十几项（地址、凭据、各种开关），
      塞进表格行里会把那一行撑成半屏高，而其余几行的操作按钮被推得看不见。
    -->
    <Modal
      :open="editing !== undefined"
      :title="`配置 ${editing?.record.label ?? editing?.record.id ?? ''}`"
      :sub="`${editAdapter?.name ?? editing?.record.adapterId ?? ''}${configChanged ? ' · 适配器配置已改动，保存后会自动重连该账号' : ''}`"
      wide
      @close="closeEdit()"
    >
      <p v-if="editError !== ''" class="banner">{{ editError }}</p>

      <div class="field">
        <label for="editLabel">备注</label>
        <input id="editLabel" v-model="editLabel" placeholder="选填，用于在列表中区分多个账号" />
      </div>

      <!--
        取不到 schema 时不给空表单：适配器插件被卸载后它名下的账号仍在（那是刻意的，
        装回来就能连上），此时无从知道这份配置长什么样。硬画一个空表单会让使用者
        以为「配置项都没了」，而一保存就把原有的值清空。
      -->
      <SchemaForm
        v-if="editSchema !== undefined"
        :schema="editSchema"
        :value="editConfig"
        :issues="editIssues"
        :extras="retryTabOf(editRetry)"
        @change="onEditChange"
      >
        <template #retry>
          <RetryFields v-model="editRetry" :global="globalRetry" in-tab />
        </template>
      </SchemaForm>
      <template v-else>
        <p class="hint">
          该账号所属的适配器 <code>{{ editing?.record.adapterId }}</code> 当前未注册（插件未装或已卸载），
          故无从知道它的配置项长什么样。装回该适配器插件后即可在此编辑；备注与下方的重连策略不经适配器，
          内核 0.5.2 起可以直接改。
        </p>
        <RetryFields v-model="editRetry" :global="globalRetry" />
      </template>
      <template #actions>
        <button @click="closeEdit()">取消</button>
        <button
          class="primary"
          :disabled="editing !== undefined && busy === editing.record.id"
          @click="void saveEdit()"
        >
          {{ configChanged ? "保存并重连" : "保存" }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
@layer base {
  .acc-panel {
    display: grid;
    gap: var(--s3);
  }

  .acc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    flex-wrap: wrap;
  }

  .acc-title {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
    min-width: 0;
  }

  .acc-title h2 {
    margin: 0;
  }

  .acc-panel > .hint {
    margin: 0;
  }

  .acc-login {
    padding: var(--s4);
    border: 1px dashed var(--border-strong);
    border-radius: var(--r-ctl);
  }

  .acc-modes {
    margin-bottom: var(--s2);
  }

  .acc-manual {
    margin-bottom: var(--s4);
  }
}
</style>
