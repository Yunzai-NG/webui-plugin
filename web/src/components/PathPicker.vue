<script setup lang="ts">
/**
 * 模块职责：模态的服务器目录浏览器 —— 为 `file` / `dir` 配置项挑一个路径
 * 依赖方向：依赖 api / format / paths / pathpick；不认识任何具体页面
 * 生命周期：由 `App.vue` 挂一个实例，随外壳存活
 * 注意事项：**它列的是内核那台机器的目录，不是浏览器这台** —— `<input type="file">` 拿不到
 *          所在目录，而配置项要的恰是服务器上的绝对路径。
 *
 *          **手敲路径的入口必须保留**（在 `SchemaField` 那一侧）：只读模式下目录浏览接口停用，
 *          本组件打不开，而字段仍须可填。
 *
 *          原生 `<dialog>`，与 `ConfirmDialog` 同一手法：**只在 `close` 里结算取消**，
 *          「选定」先结算、close 触发的第二次由 `settlePath` 视作空操作。`cancel` 一律拦掉、
 *          `pending` 清空时不主动 `close()` —— 两者都会使元素立刻消隐，离场动画播不出来
 *          （详见 `Modal.vue` 文件头）。
 *
 *          初始焦点落在路径输入框：粘贴比逐层点开快。
 */
import { computed, nextTick, ref, watch } from "vue"
import { get } from "../api.js"
import { errorText } from "../format.js"
import { crumbsOf, dirOf, joinPath } from "../paths.js"
import { pending, settlePath } from "../pathpick.js"

/** `GET /api/fs` 的响应 */
interface Listing {
  /** 规范化后的绝对路径；最外层为空串 */
  path: string
  /** 上一级；已在最外层时缺省 */
  parent?: string
  /** 条目 */
  entries: Array<{
    /** 名字 */
    name: string
    /** 是否目录 */
    dir: boolean
    /** 是否符号链接 */
    link?: boolean
  }>
  /** 是否因超过上限而截断 */
  truncated: boolean
  /** 服务器的路径分隔符 */
  sep: string
}

const el = ref<HTMLDialogElement | undefined>(undefined)
const box = ref<HTMLInputElement | undefined>(undefined)
const listing = ref<Listing | undefined>(undefined)
const error = ref("")
const loading = ref(false)
/** 输入框里的路径：可手敲，也随点击目录而变 */
const draft = ref("")

/** 当前是否在选目录 */
const dirMode = computed(() => pending.value?.mode === "dir")

/** 面包屑 */
const crumbs = computed(() => (listing.value === undefined ? [] : crumbsOf(listing.value.path, listing.value.sep)))

/**
 * 可选中的条目
 *
 * 选目录时把文件也列出来但不可点：隐去文件会让人以为目录是空的，而「这里有六个文件」
 * 本身就是判断「是不是这个目录」的依据。
 */
const entries = computed(() => listing.value?.entries ?? [])

/**
 * 拉取一个目录
 *
 * 初次打开时若起点已不存在（配置里填的目录被删了），退回内核决定的最外层重试一次 ——
 * 直接把 404 摆给使用者，他还得自己想「那我该从哪儿开始」。
 * @param target 目标目录；空串表示最外层
 * @param fallback 失败时是否退回最外层重试
 * @param keep 要保留在输入框里的路径；不传则填入实际到达的目录
 */
async function load(target: string, fallback = false, keep?: string): Promise<void> {
  loading.value = true
  error.value = ""
  try {
    const query = target === "" ? "" : `?path=${encodeURIComponent(target)}`
    listing.value = await get<Listing>(`fs${query}`)
    // 选文件时起点是「文件所在的目录」，而输入框里该留着那个**文件** ——
    // 覆盖成目录的话，打开选择器后直接点「选定」就把一个目录写进了文件字段
    draft.value = keep ?? listing.value.path
  } catch (err) {
    if (fallback) {
      loading.value = false
      await load("", false, keep)
      return
    }
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}

// 请求到来时开对话框并拉起始目录。结算之后什么都不做：见文件头
watch(pending, async request => {
  if (request === undefined) return
  listing.value = undefined
  error.value = ""
  draft.value = request.start ?? ""
  await nextTick()
  const next = el.value
  if (next !== undefined && !next.open) {
    next.showModal()
    box.value?.focus()
  }
  // 起点由调用方给：选目录时是那个目录本身，选文件时是文件所在的目录。
  // 无论哪种，输入框里都保留调用方给的原值（`keep`），列的却是那个目录
  const from = request.mode === "dir" ? (request.start ?? "") : dirOf(request.start ?? "", guessSep(request.start ?? ""))
  await load(from, from !== "", request.start)
})

/**
 * 猜一个分隔符
 *
 * 只用于「由起点算出它所在的目录」这一步，此时还没拿到内核给的 `sep`。猜错的代价
 * 是起点退回最外层（`load` 的 fallback 兜住），而不是一个错误的结果。
 * @param sample 一条路径
 * @returns 分隔符
 */
function guessSep(sample: string): string {
  return sample.includes("\\") ? "\\" : "/"
}

/**
 * 点开一个条目
 *
 * 目录：进去。文件：选目录时不响应，选文件时把它填进输入框（不直接结算 ——
 * 单击即关会让「点错一个再点对的」变成「重新打开一次」）。
 * @param entry 条目
 */
function open(entry: { name: string; dir: boolean }): void {
  const current = listing.value
  if (current === undefined) return
  const full = joinPath(current.path, entry.name, current.sep)
  if (entry.dir) {
    void load(full)
    return
  }
  if (!dirMode.value) draft.value = full
}

/** 回到上一级 */
function up(): void {
  const parent = listing.value?.parent
  if (parent !== undefined) void load(parent)
}

/** 按输入框里的路径跳转 */
function go(): void {
  const target = draft.value.trim()
  if (target === "") return
  // 选文件时输入的很可能是文件本身，此时跳到它所在的目录
  const current = listing.value
  const sep = current?.sep ?? "/"
  void load(dirMode.value ? target : (dirOf(target, sep) || target))
}

/**
 * 点在对话框之外即取消
 * @param event 鼠标事件
 */
function onClick(event: MouseEvent): void {
  if (event.target === el.value) settlePath(undefined)
}

/** 把输入框里的路径作为结果交回 */
function choose(): void {
  const picked = draft.value.trim()
  if (picked === "") return
  settlePath(picked)
}
</script>

<template>
  <Transition name="pop">
    <dialog
      v-if="pending"
      ref="el"
      class="modal wide"
      @cancel.prevent="settlePath(undefined)"
      @close="settlePath(undefined)"
      @click="onClick"
    >
      <h2>{{ pending.title }}</h2>
      <p class="hint">
        {{ dirMode ? "请选择服务器上的一个目录" : "请选择服务器上的一个文件" }}。此处列出的是运行内核那台机器的目录。
      </p>

      <!-- 路径输入框：粘贴比逐层点开快，也是接口取不到目录时的唯一出路 -->
      <div class="pathbar">
        <input
          ref="box"
          v-model="draft"
          type="text"
          aria-label="路径"
          placeholder="可直接粘贴绝对路径"
          @keydown.enter.prevent="go()"
        />
        <button type="button" @click="go()">前往</button>
      </div>

      <!--
        面包屑：每一节都可点回。**一直在场**，到最外层时只剩「最外层」一枚 ——
        整条隐去会让下方列表向上跳一格，而使用者刚做的动作只是「往上一层」。
      -->
      <nav v-if="listing" class="crumbs" aria-label="路径层级">
        <button type="button" @click="void load('')">最外层</button>
        <button v-for="crumb in crumbs" :key="crumb.path" type="button" @click="void load(crumb.path)">
          {{ crumb.label }}
        </button>
      </nav>

      <p v-if="error" class="banner">{{ error }}</p>

      <div class="browser">
        <p v-if="loading" class="hint">读取中…</p>
        <template v-else-if="listing">
          <button v-if="listing.parent !== undefined" type="button" class="fsrow up" @click="up()">
            <span class="fsname">上一级</span>
          </button>
          <p v-if="entries.length === 0" class="hint">这个目录是空的</p>
          <button
            v-for="entry in entries"
            :key="entry.name"
            type="button"
            class="fsrow"
            :class="{ dir: entry.dir, mute: !entry.dir && dirMode }"
            :disabled="!entry.dir && dirMode"
            @click="open(entry)"
          >
            <span class="fsname">{{ entry.name }}</span>
            <span v-if="entry.link" class="tag">链接</span>
          </button>
          <p v-if="listing.truncated" class="hint">
            条目过多，只列出了前 1000 项。可在上方直接输入完整路径。
          </p>
        </template>
      </div>

      <div class="modal-actions">
        <button @click="settlePath(undefined)">取消</button>
        <button class="primary" :disabled="draft.trim() === ''" @click="choose()">选定</button>
      </div>
    </dialog>
  </Transition>
</template>
