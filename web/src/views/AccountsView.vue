<script setup lang="ts">
/**
 * 模块职责：账号页 —— 适配器列表、账号增删改与连接控制、交互式登录会话
 * 依赖方向：依赖 api / format / SchemaForm / types
 * 生命周期：挂载时拉取一次；存在进行中的登录会话时按秒轮询
 * 注意事项：**添加账号有两条路径，取决于适配器声明的能力**：声明了 `loginModes` 的走交互式登录
 *          （扫码、验证码），会话由内核驱动，面板只渲染 steps 并把 prompt 的答案回送；未声明者
 *          手工填配置，表单由 `accountSchema` 驱动 —— 与配置页共用同一套组件。
 *
 *          **登录会话用轮询而非 WebSocket**：一次扫码只存续数分钟、状态变化不足十次，推送通道
 *          要多一个内核端点与一套重连逻辑，换来的只是把 1 秒延迟降到 0。
 *
 *          轮询只在**存在进行中的会话**时启用（见 `syncLogins`），空闲时不留任何定时器。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue"
import { del, get, patch, post } from "../api.js"
import { defaultsOf, snapshot } from "../configedit.js"
import { errorText, statusClass, statusText } from "../format.js"
import { globalRetryOf, isRetryCustom, retryFormOf, retryOverrideOf, retrySummary } from "../retry.js"
import { askConfirm } from "../confirm.js"
import Modal from "../components/Modal.vue"
import PageHeader from "../components/PageHeader.vue"
import RetryFields from "../components/RetryFields.vue"
import SchemaForm from "../components/SchemaForm.vue"
import { ApiError } from "../api.js"
import type { GlobalRetry, RetryForm } from "../retry.js"
import type { AccountItem, AdapterSummary, ConfigDetail, LoginSnapshot, LoginStep, SchemaIssue } from "../types.js"

/** 存在进行中的会话时的轮询间隔 */
const POLL_MS = 1000

/** 内核配置名，与内核 `CORE_CONFIG_NAME` 一致（对应 `config/yunzai.yaml`） */
const CORE_CONFIG = "yunzai"

const adapters = ref<AdapterSummary[]>([])
const accounts = ref<AccountItem[]>([])
const logins = ref<LoginSnapshot[]>([])
const error = ref("")
const busy = ref("")

/** 正在新建的账号：所选适配器 */
const draftAdapter = ref("")
/** 新建账号的配置值 */
const draftConfig = ref<Record<string, unknown>>({})
/** 新建账号的备注 */
const draftLabel = ref("")
/** 新建账号的逐字段错误 */
const draftIssues = ref<readonly SchemaIssue[]>([])
/**
 * 新建账号的重连覆盖，四项皆以字符串存 —— 空串即「跟随全局」
 *
 * **建号时就能填，而不是建完再进一次配置框。** 内核的 `POST accounts` 本就收 `retry`
 * （`api.ts` 的 `retryOverrideOf`），且刻意做成一次 `create()` 完成 —— 建完再 PATCH
 * 一次会因 `config` 到达而断开重连，一个刚接上的号先闪一次离线。
 *
 * 与 `draftConfig` 分开的理由同 `editRetry`：这四项归内核所有，不属于任何适配器的 schema。
 */
const draftRetry = ref<RetryForm>(retryFormOf(undefined))
/** 用户为当前提问填写的答案 */
const answers = ref<Record<string, string>>({})
/** 适配器下拉是否展开 */
const adapterDropdownOpen = ref(false)
/** 适配器下拉悬停索引 */
const adapterDropdownHover = ref(-1)

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

let timer: number | undefined

/** 当前选中的适配器描述 */
const draft = computed(() => adapters.value.find(a => a.id === draftAdapter.value))

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
 * 判它是为了**不为一次只改重连策略的保存踢掉一个在线的号**。内核的 `update()` 只要收到
 * `config` 就断开重连，那是对的 —— 地址或 token 变了而 socket 还是旧的，使用者会以为
 * 「改了没生效」；而 `label` 与 `retry` 都不参与建连，内核那侧专门为此留了「只动这两项
 * 就不动连接」的路。面板若每次都捎上 `config`，那条路永远走不到，一次把上限从 5 改成 10
 * 的保存会让这个号断线重连，那期间的消息全丢。
 *
 * 比 JSON 文本而非深比对：此处只需判「有没有动过」，而任何一处取值改变都会让序列化结果
 * 不同（`editConfig` 是同一对象的 `snapshot`，键序本就一致）。**宁可多判成变了**
 * —— 代价只是多一次重连；漏判的代价是「改了地址却没重连」，那正是要防的那件事。
 */
const configChanged = computed(() => {
  const before = editing.value?.record.config
  if (before === undefined) return false
  return JSON.stringify(before) !== JSON.stringify(editConfig.value)
})

/*
 * 换适配器即按它的 schema 铺一遍默认值
 *
 * **不铺的话表单是全空的。** 新建账号从空对象起步，而 `default` 只写在 schema 里 ——
 * NapCat 的连接地址声明了 `ws://127.0.0.1:3001`，使用者看到的却是一个空框，得自己
 * 照文档敲一遍。内核配置那边不缺这一步：值由 node 侧读文件时就填好了默认值。
 *
 * 铺的是**副本**（`defaultsOf` 每次新造对象），故改动不会污染 schema 里的声明；
 * 换一次适配器就整份重铺，不保留上一个适配器填过的东西 —— 两者的字段本就不同名，
 * 留下来只会把 A 的地址带进 B 的表单。
 *
 * **`draftRetry` 不跟着重铺**：那四项归内核所有，字段与适配器无关，换一次适配器
 * 把「我要这个号最多重连 3 次」抹掉没有道理。
 */
watch(draft, adapter => {
  draftConfig.value = adapter === undefined ? {} : defaultsOf(adapter.accountSchema)
  draftIssues.value = []
})

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
  await loadGlobalRetry()
  await syncLogins()
}

/**
 * 取全局重连四项
 *
 * **只留这四个数，整份内核配置不在这一页落地。** `GET config/:name` 刻意不脱敏（面板要能
 * 显示与轮换面板令牌、要能显示适配器的连接密钥），响应体里带着 `server.token`；账号页要的
 * 只是四个数字，没有理由让其余部分在这一页的状态里多待一秒。挑取在 `globalRetryOf` 里。
 *
 * 失败即静默：读不到只是让「跟随全局」少一个括号里的数，表单照旧可用 —— 不该盖掉页面上
 * 更要紧的那条错误（账号列表拉取失败）。
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
 * 对某个账号执行动作
 * @param id 账号 id
 * @param action 动作
 */
async function act(id: string, action: "connect" | "disconnect" | "reconnect"): Promise<void> {
  busy.value = id
  try {
    // 端点返回动作执行后的状态，就地替换该行即可，无须重新拉取整张表
    const next = await post<AccountItem | undefined>(`accounts/${encodeURIComponent(id)}/${action}`)
    if (next !== undefined) accounts.value = accounts.value.map(a => (a.record.id === id ? next : a))
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
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
  busy.value = id
  try {
    await del(`accounts/${encodeURIComponent(id)}`)
    accounts.value = accounts.value.filter(a => a.record.id !== id)
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 切换启用状态
 * @param item 账号
 */
async function toggleEnabled(item: AccountItem): Promise<void> {
  busy.value = item.record.id
  try {
    const next = await patch<AccountItem>(`accounts/${encodeURIComponent(item.record.id)}`, {
      enabled: !item.record.enabled
    })
    accounts.value = accounts.value.map(a => (a.record.id === item.record.id ? next : a))
    error.value = ""
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 记录一项新建表单的改动
 * @param path 点号路径
 * @param value 新值
 */
function onDraftChange(path: string, value: unknown): void {
  const parts = path.split(".")
  const leaf = parts.pop()
  if (leaf === undefined) return
  let node = draftConfig.value
  for (const part of parts) {
    const existing = node[part]
    if (typeof existing !== "object" || existing === null) node[part] = {}
    node = node[part] as Record<string, unknown>
  }
  node[leaf] = value
}

/**
 * 依据手工填写的配置创建账号
 *
 * **四项全空即不送 `retry`**（而非像编辑那样送 `null`）：`null` 的意思是「清掉已有的覆盖」，
 * 而一个还不存在的账号没有覆盖可清。内核的 `create()` 也只在有键时才存这一项，送空对象
 * 与不送等价 —— 但少送一个字段就少一处要内核去理解的意图。
 */
async function createAccount(): Promise<void> {
  const adapter = draft.value
  if (adapter === undefined) return
  busy.value = "new"
  draftIssues.value = []
  try {
    const retry = retryOverrideOf(draftRetry.value)
    await post("accounts", {
      adapterId: adapter.id,
      config: draftConfig.value,
      ...(draftLabel.value === "" ? {} : { label: draftLabel.value }),
      ...(retry === null ? {} : { retry })
    })
    draftAdapter.value = ""
    draftConfig.value = {}
    draftLabel.value = ""
    draftRetry.value = retryFormOf(undefined)
    error.value = ""
    await refreshAccounts()
  } catch (err) {
    if (err instanceof ApiError && err.issues.length > 0) draftIssues.value = err.issues
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/* ─────────────── 改已有账号的配置 ─────────────── */

/**
 * 打开编辑框
 *
 * 深拷一份再改，**不直接改 `item.record.config`**：那个对象来自列表，直接改的话使用者点「取消」
 * 之后表格里显示的已经是改过的值，而服务端上并没有变 —— 一次没保存的编辑就此变成了假象。
 * @param item 账号
 */
function openEdit(item: AccountItem): void {
  editing.value = item
  /*
   * 用 `snapshot`（JSON 往返）而非 `structuredClone`
   *
   * `accounts` 是个 `ref`，`item.record.config` 取到的是 Vue 的响应式代理，而
   * `structuredClone` 克隆代理直接抛 DataCloneError —— 它抛在 `editing.value = item`
   * 之后，于是模态照常打开、`editConfig` 停在空对象：**表现为「点配置，配置项全是空的」**，
   * 且因为空对象与已存的配置不同，标题还会挂上一句「适配器配置已改动」，一保存就把
   * 这个号的地址与凭据清空。配置值本身来自 JSON 响应，JSON 往返对它无损。
   */
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
  const parts = path.split(".")
  const leaf = parts.pop()
  if (leaf === undefined) return
  let node = editConfig.value
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
 * **`config` 只在真的改过时才送**（见 `configChanged`）：内核收到它就会断开并重连这个账号，
 * 而只改了备注或重连策略的保存不该让一个在线的号掉一次线。故这次保存会不会重连，由内容
 * 决定而非由按钮决定 —— 按钮的文案跟着 `configChanged` 变。
 *
 * `retry` 一律送，且用三态里的两态：填了至少一项即送对象，四项全空即送 `null`
 * （清掉覆盖、回到跟随全局）。不送的那一态（「这次不动它」）在这里没有用武之地 ——
 * 表单已把当前值完整铺开，使用者看到什么就是要保存什么。
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

/**
 * 发起一个交互式登录会话
 * @param adapterId 适配器 id
 * @param mode 登录方式 id
 */
async function startLogin(adapterId: string, mode: string): Promise<void> {
  busy.value = "login"
  try {
    await post<LoginSnapshot>("logins", {
      adapterId,
      mode,
      ...(draftLabel.value === "" ? {} : { label: draftLabel.value })
    })
    error.value = ""
    await syncLogins()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
}

/**
 * 回答当前提问
 * @param session 会话
 * @param value 答案；确认型传布尔
 */
async function answer(session: LoginSnapshot, value: unknown): Promise<void> {
  const pending = session.pending
  if (pending === undefined) return
  busy.value = session.id
  try {
    await post(`logins/${encodeURIComponent(session.id)}/answer`, { seq: pending.seq, value })
    delete answers.value[session.id]
    error.value = ""
    await syncLogins()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = ""
  }
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

/**
 * 将一个步骤中的图片转换为 img 可用的 src
 *
 * 仅处理 `url` 与 `base64`：`path` 为内核所在主机的绝对路径，浏览器无法读取；
 * `buffer` 经 JSON 序列化后成为 `{"0":137,...}`，此处一并还原 ——
 * 渲染器生成的二维码即为该形态，不还原则显示为损坏的图片。
 * @param step 登录步骤
 * @returns img 的 src；无法展示时返回空串
 */
function imageSrc(step: LoginStep): string {
  if (step.type !== "qrcode") return ""
  const image = step.image as Record<string, unknown>
  if (image.kind === "url" && typeof image.url === "string") return image.url
  if (image.kind === "base64" && typeof image.base64 === "string") {
    return `data:${typeof image.mime === "string" ? image.mime : "image/png"};base64,${image.base64}`
  }
  if (image.kind === "buffer" && typeof image.data === "object" && image.data !== null) {
    const bytes = Object.values(image.data as Record<string, number>)
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return `data:${typeof image.mime === "string" ? image.mime : "image/png"};base64,${btoa(binary)}`
  }
  return ""
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

    <p v-if="adapters.length === 0" class="banner warn">
      尚未加载任何适配器插件。请先安装一个（如 <code>adapter-napcat</code>）并在插件页确认其已加载，此处方会出现可选项。
    </p>

    <!-- ───── 进行中的登录会话 ───── -->
    <template v-if="logins.length > 0">
      <h2>登录会话</h2>
      <div v-for="session in logins" :key="session.id" class="card">
        <div class="row">
          <b>{{ session.adapterId }}</b>
          <span class="tag">{{ session.mode }}</span>
          <span class="tag" :class="statusClass(session.status)">{{ statusText(session.status) }}</span>
          <button v-if="session.status === 'running'" class="danger" @click="void cancelLogin(session.id)">
            取消
          </button>
        </div>

        <ol class="steps">
          <li v-for="(step, i) in session.steps" :key="i">
            <template v-if="step.type === 'info'">{{ step.text }}</template>
            <template v-else-if="step.type === 'url'">
              {{ step.text ?? "请在浏览器中打开：" }}
              <a :href="step.url" target="_blank" rel="noreferrer">{{ step.url }}</a>
            </template>
            <template v-else-if="step.type === 'progress'">{{ step.text ?? "进行中" }}（{{ step.percent }}%）</template>
            <template v-else-if="step.type === 'qrcode'">
              {{ step.text ?? "请使用手机扫码" }}
              <div v-if="imageSrc(step)">
                <img class="qr" :src="imageSrc(step)" alt="登录二维码" />
              </div>
              <p v-else class="hint">二维码无法在面板中显示（适配器提供的是本机文件路径），请查阅日志中的提示。</p>
            </template>
          </li>
        </ol>

        <!-- 提问：内核仅提供类型与标签，控件形态在此处决定 -->
        <div v-if="session.pending" class="field">
          <label>{{ session.pending.prompt.label }}</label>
          <p v-if="session.pending.prompt.description" class="hint">{{ session.pending.prompt.description }}</p>

          <div v-if="session.pending.prompt.type === 'confirm'" class="row">
            <button class="primary" :disabled="busy === session.id" @click="void answer(session, true)">确认</button>
            <button :disabled="busy === session.id" @click="void answer(session, false)">拒绝</button>
          </div>

          <div v-else-if="session.pending.prompt.type === 'select'" class="row">
            <button
              v-for="opt in session.pending.prompt.options ?? []"
              :key="String(opt.value)"
              :disabled="busy === session.id"
              @click="void answer(session, opt.value)"
            >
              {{ opt.label ?? String(opt.value) }}
            </button>
          </div>

          <div v-else class="row">
            <input
              v-model="answers[session.id]"
              :type="session.pending.prompt.type === 'password' ? 'password' : 'text'"
              style="width: 240px"
              @keyup.enter="void answer(session, answers[session.id] ?? '')"
            />
            <button class="primary" :disabled="busy === session.id" @click="void answer(session, answers[session.id] ?? '')">
              提交
            </button>
          </div>
        </div>

        <p v-if="session.error" class="err">{{ session.error }}</p>
        <p v-if="session.accountId" class="hint">已创建账号 {{ session.accountId }}</p>
      </div>
    </template>

    <!-- ───── 账号列表 ───── -->
    <h2>已配置账号（{{ accounts.length }}）</h2>
    <div class="card">
      <table class="rows">
        <thead>
          <tr>
            <th>账号</th>
            <th>适配器</th>
            <th>状态</th>
            <th>启用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in accounts" :key="item.record.id">
            <td data-label="账号">
              <b>{{ item.record.label ?? item.record.selfId ?? item.record.id }}</b>
              <p class="hint mono">{{ item.record.id }}</p>
            </td>
            <td data-label="适配器">{{ item.record.adapterId }}</td>
            <td data-label="状态">
              <span class="tag" :class="statusClass(item.status)">{{ statusText(item.status) }}</span>
              <span v-if="item.retries > 0" class="tag warn">重试 {{ item.retries }} 次</span>
              <p v-if="item.error" class="err">{{ item.error }}</p>
              <!--
                自定义重连策略要在列表上留下痕迹

                它是一条看不见的状态，而「这个号为什么不再重试了」的答案往往就在里面 ——
                只在编辑框里才看得到的话，排查要先点开五个账号。摘要只列填了的那几项，
                跟随全局的项不算这个号自己的事。
              -->
              <p v-if="isRetryCustom(item.record.retry)" class="hint">
                重连策略：{{ retrySummary(item.record.retry) }}
              </p>
            </td>
            <td data-label="启用">
              <label class="check">
                <input
                  type="checkbox"
                  :checked="item.record.enabled"
                  :disabled="busy === item.record.id"
                  @change="void toggleEnabled(item)"
                />
                <span class="checkmark"></span>
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
                <!--
                  改这个账号的配置

                  内核的 `PATCH accounts/:id` 一直支持改 `config`，此前只是面板没给入口 ——
                  表现为「适配器配置改不了，只能删掉重建」，而重建会丢掉登录态。
                -->
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
          <tr v-if="accounts.length === 0">
            <td colspan="5" class="hint">尚未配置账号。选择适配器后可手工填写配置，或使用其提供的交互式登录方式。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ───── 添加账号 ───── -->
    <h2>添加账号</h2>
    <div class="card">
      <div class="field">
        <label>适配器</label>
        <div class="cdd" :class="{ open: adapterDropdownOpen }">
          <button
            type="button"
            class="cdd-trigger"
            :aria-expanded="adapterDropdownOpen"
            @click="adapterDropdownOpen = !adapterDropdownOpen"
          >
            <span class="cdd-value">{{ draftAdapter ? adapters.find(a => a.id === draftAdapter)?.name ?? draftAdapter : '请选择' }}</span>
            <svg class="cdd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <Transition name="cdd-fx">
            <div v-if="adapterDropdownOpen" class="cdd-menu" role="listbox">
              <button
                v-for="(a, idx) in adapters"
                :key="a.id"
                type="button"
                role="option"
                :aria-selected="String(a.id) === String(draftAdapter) ? 'true' : 'false'"
                :class="{ active: a.id === draftAdapter, hover: idx === adapterDropdownHover }"
                @click="draftAdapter = a.id; adapterDropdownOpen = false"
                @mouseenter="adapterDropdownHover = idx"
                @mouseleave="adapterDropdownHover = -1"
              >
                {{ a.name }}（{{ a.platform }}）
              </button>
            </div>
          </Transition>
        </div>
        <p v-if="draft?.description" class="hint">{{ draft.description }}</p>
      </div>

      <template v-if="draft">
        <div class="field">
          <label for="label">备注</label>
          <input id="label" v-model="draftLabel" placeholder="选填，用于在列表中区分多个账号" />
        </div>

        <!-- 提供交互式登录时优先呈现：手工填写凭据为最易出错的一步 -->
        <template v-if="(draft.loginModes ?? []).length > 0">
          <p class="hint">该适配器支持交互式登录，建议采用以下方式完成接入：</p>
          <div class="row" style="margin-bottom: 16px">
            <button
              v-for="mode in draft.loginModes ?? []"
              :key="mode.id"
              class="primary"
              :disabled="busy === 'login'"
              @click="void startLogin(draft.id, mode.id)"
            >
              {{ mode.name }}
            </button>
          </div>
          <h2>或手工填写配置</h2>
        </template>

        <SchemaForm
          :schema="draft.accountSchema"
          :value="draftConfig"
          :issues="draftIssues"
          @change="onDraftChange"
        />

        <!--
          重连策略在建号时就给出，而非建完再进一次配置框

          内核的 `POST accounts` 本就收 `retry`，且刻意做成一次 `create()` ——
          建完再 PATCH 一次会因 `config` 到达而断开重连，一个刚接上的号先闪一次离线。
          与「配置」模态里是同一个组件，故两处的文案与语义不会走散。
        -->
        <RetryFields v-model="draftRetry" :global="globalRetry" />

        <button class="primary" :disabled="busy === 'new'" @click="void createAccount()">创建账号</button>
      </template>
    </div>

    <!--
      ───── 改已有账号的配置 ─────

      做成模态而不是在表格里展开一行：一份账号配置动辄十几项（地址、凭据、各种开关），
      塞进表格行里会把那一行撑成半屏高，而其余几行的操作按钮被推得看不见。

      `wide` 形制：表单与「添加账号」处同一套 `SchemaForm`，窄框里每个字段都要折行。
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
        @change="onEditChange"
      />
      <p v-else class="hint">
        该账号所属的适配器 <code>{{ editing?.record.adapterId }}</code> 当前未注册（插件未装或已卸载），
        故无从知道它的配置项长什么样。装回该适配器插件后即可在此编辑；备注与下方的重连策略不经适配器，
        内核 0.5.2 起可以直接改。
      </p>

      <RetryFields v-model="editRetry" :global="globalRetry" />
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
