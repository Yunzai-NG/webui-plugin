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
import { defaultsOf } from "../configedit.js"
import { errorText, statusClass, statusText } from "../format.js"
import { askConfirm } from "../confirm.js"
import Modal from "../components/Modal.vue"
import PageHeader from "../components/PageHeader.vue"
import SchemaForm from "../components/SchemaForm.vue"
import { ApiError } from "../api.js"
import type { AccountItem, AdapterSummary, LoginSnapshot, LoginStep, SchemaIssue } from "../types.js"

/** 存在进行中的会话时的轮询间隔 */
const POLL_MS = 1000

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
/** 编辑保存时的逐字段错误 */
const editIssues = ref<readonly SchemaIssue[]>([])
/** 编辑保存失败的原因，只显示在模态内 —— 页顶那条使用者此刻看不到 */
const editError = ref("")

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
  await syncLogins()
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

/** 依据手工填写的配置创建账号 */
async function createAccount(): Promise<void> {
  const adapter = draft.value
  if (adapter === undefined) return
  busy.value = "new"
  draftIssues.value = []
  try {
    await post("accounts", {
      adapterId: adapter.id,
      config: draftConfig.value,
      ...(draftLabel.value === "" ? {} : { label: draftLabel.value })
    })
    draftAdapter.value = ""
    draftConfig.value = {}
    draftLabel.value = ""
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
  // structuredClone 而非 JSON 往返：配置里可能有 undefined 与嵌套对象，后者会被 JSON 悄悄丢掉
  editConfig.value = structuredClone(item.record.config)
  editLabel.value = item.record.label ?? ""
  editIssues.value = []
  editError.value = ""
}

/** 关掉编辑框 */
function closeEdit(): void {
  editing.value = undefined
  editConfig.value = {}
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
 * 内核收到 `config` 之后会**断开并重连**这个账号（见 adapter/accounts.ts 的 `update`）：
 * 地址或凭据变了而 socket 还是旧的，使用者会以为「改了没生效」。故此处保存完要重取列表，
 * 那时状态多半是 `connecting`。
 */
async function saveEdit(): Promise<void> {
  const item = editing.value
  if (item === undefined) return
  busy.value = item.record.id
  editIssues.value = []
  try {
    const label = editLabel.value.trim()
    await patch<AccountItem>(`accounts/${encodeURIComponent(item.record.id)}`, {
      config: editConfig.value,
      label
    })
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
      :sub="editSchema === undefined ? '' : `${editAdapter?.name ?? editing?.record.adapterId} · 保存后会自动重连该账号`"
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
        故无从知道它的配置项长什么样。装回该适配器插件后即可在此编辑，现在仍可改备注。
      </p>

      <template #actions>
        <button @click="closeEdit()">取消</button>
        <button
          class="primary"
          :disabled="editing !== undefined && busy === editing.record.id"
          @click="void saveEdit()"
        >
          保存并重连
        </button>
      </template>
    </Modal>
  </div>
</template>
