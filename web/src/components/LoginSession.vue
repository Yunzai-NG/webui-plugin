<script setup lang="ts">
/**
 * 模块职责：一个交互式登录会话 —— 已推送的步骤（文字、链接、进度、二维码）与当前的提问
 * 依赖方向：依赖 accountview（二维码转 src）、format 与 types
 * 生命周期：随调用方；会话的轮询与回答的请求都在调用方，这里只渲染并往外报
 * 注意事项：添加账号的弹窗与账号页签下各用一份：弹窗是使用者刚发起的那个，页签下是关掉弹窗后
 *          仍在进行的那些 —— 关弹窗不取消会话，扫到一半关掉也能在页签下接着扫。
 *
 *          提问只给了类型与标签，控件长什么样在这里决定。
 */
import { ref } from "vue"
import { qrSrcOf } from "../accountview.js"
import { safeHref } from "../links.js"
import { statusClass, statusText } from "../format.js"
import type { LoginSnapshot } from "../types.js"

defineProps<{
  /** 会话 */
  session: LoginSnapshot
  /** 登录方式的显示名；取不到时显示 id */
  modeName?: string
  /** 是否正在提交，提交期间按钮置灰 */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** 回答当前提问；确认型为布尔 */
  answer: [value: unknown]
  /** 取消会话 */
  cancel: []
}>()

/** 文字型提问的草稿 */
const draft = ref("")

/**
 * 交出文字答案，并清掉草稿
 */
function submit(): void {
  emit("answer", draft.value)
  draft.value = ""
}
</script>

<template>
  <div class="login-session">
    <div class="row">
      <b>{{ modeName ?? session.mode }}</b>
      <span class="tag" :class="statusClass(session.status)">{{ statusText(session.status) }}</span>
      <button v-if="session.status === 'running'" class="danger" @click="emit('cancel')">取消</button>
    </div>

    <ol class="login-steps">
      <li v-for="(step, i) in session.steps" :key="i">
        <template v-if="step.type === 'info'">{{ step.text }}</template>
        <template v-else-if="step.type === 'url'">
          {{ step.text ?? "请在浏览器中打开：" }}
          <a v-if="safeHref(step.url)" :href="safeHref(step.url)" target="_blank" rel="noreferrer noopener">{{ step.url }}</a>
          <span v-else class="mono">{{ step.url }}</span>
        </template>
        <template v-else-if="step.type === 'progress'">{{ step.text ?? "进行中" }}（{{ step.percent }}%）</template>
        <template v-else-if="step.type === 'qrcode'">
          {{ step.text ?? "请使用手机扫码" }}
          <div v-if="qrSrcOf(step)">
            <img class="qr" :src="qrSrcOf(step)" alt="登录二维码" />
          </div>
          <p v-else class="hint">二维码无法在面板中显示（适配器提供的是本机文件路径），请查阅日志中的提示。</p>
        </template>
      </li>
    </ol>

    <div v-if="session.pending" class="field">
      <label>{{ session.pending.prompt.label }}</label>
      <p v-if="session.pending.prompt.description" class="hint">{{ session.pending.prompt.description }}</p>

      <div v-if="session.pending.prompt.type === 'confirm'" class="row">
        <button class="primary" :disabled="busy" @click="emit('answer', true)">确认</button>
        <button :disabled="busy" @click="emit('answer', false)">拒绝</button>
      </div>

      <div v-else-if="session.pending.prompt.type === 'select'" class="row">
        <button
          v-for="opt in session.pending.prompt.options ?? []"
          :key="String(opt.value)"
          :disabled="busy"
          @click="emit('answer', opt.value)"
        >
          {{ opt.label ?? String(opt.value) }}
        </button>
      </div>

      <div v-else class="row">
        <input
          v-model="draft"
          class="login-answer"
          :type="session.pending.prompt.type === 'password' ? 'password' : 'text'"
          :aria-label="session.pending.prompt.label"
          @keyup.enter="submit()"
        />
        <button class="primary" :disabled="busy" @click="submit()">提交</button>
      </div>
    </div>

    <p v-if="session.error" class="err">{{ session.error }}</p>
  </div>
</template>
