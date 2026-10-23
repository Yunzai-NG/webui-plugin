<script setup lang="ts">
/**
 * 模块职责：外观页 —— 主题、明暗、版式、动效、备份五个页签
 * 依赖方向：依赖 appearance / scheme / themes / download 与 AppIcon、PageHeader、TabBar
 * 生命周期：随所在页面
 * 注意事项：所有修改经 appearance.ts 写成 CSS 变量与 `<html data-*>`，即时生效、自动落盘，本页不另存。
 *
 *          **「主题」页签里的强调色、圆角、背景只对当前主题生效**，按主题分别保存；主题在清单里没开放
 *          的项整行置灰并说明。版式与动效是个人偏好，换哪款主题都跟着人走。
 *
 *          页签的选择记在地址上（`?tab=`），从别处（比如侧栏的明暗按钮的说明）链进来能直接落到那一栏。
 */
import { computed, ref, watch } from "vue"
import AppIcon from "../components/AppIcon.vue"
import PageHeader from "../components/PageHeader.vue"
import TabBar from "../components/TabBar.vue"
import {
  COLOR_PRESETS,
  DEFAULT_ACCENT_HUE,
  appearance,
  chooseTheme,
  effectiveOverrides,
  exportAppearance,
  importAppearance,
  resetAppearance,
  resetOverrides,
  resetPrefs,
  updateOverride,
  updatePref,
  type AppearancePrefs,
  type ThemeOverrides
} from "../appearance.js"
import { copyText, downloadText } from "../download.js"
import { errorText } from "../format.js"
import { ICONS, SCHEME_ICON } from "../icons.js"
import { currentQuery, hrefOf } from "../router.js"
import { SCHEME_LABEL, schemeChoice, setScheme, supportedSchemes, type SchemeChoice } from "../scheme.js"
import { currentTheme, safeMode, themeError, themeList, themesLoaded } from "../themes.js"
import { showToast } from "../toast.js"

type Tab = "theme" | "scheme" | "layout" | "motion" | "backup"

const TABS: readonly { id: Tab; label: string; icon: string }[] = [
  { id: "theme", label: "主题", icon: ICONS.palette },
  { id: "scheme", label: "明暗", icon: SCHEME_ICON.auto },
  { id: "layout", label: "版式", icon: ICONS.layers },
  { id: "motion", label: "动效", icon: ICONS.motion },
  { id: "backup", label: "备份", icon: ICONS.download }
]

const tab = ref<Tab>(TABS.some(t => t.id === currentQuery.value.tab) ? (currentQuery.value.tab as Tab) : "theme")
watch(tab, id => history.replaceState(null, "", hrefOf("appearance", id === "theme" ? {} : { tab: id })))

/** 一组分段按钮 */
interface Segment<K extends string> {
  key: K
  label: string
  hint: string
  icon: string
  options: { value: string; label: string; desc: string }[]
}

const PREF_SEGMENTS: readonly Segment<"density" | "fontScale" | "width">[] = [
  {
    key: "density",
    label: "密度",
    hint: "元素之间的间距与内边距",
    icon: ICONS.density,
    options: [
      { value: "compact", label: "紧凑", desc: "0.85×" },
      { value: "normal", label: "正常", desc: "1×" },
      { value: "comfortable", label: "舒适", desc: "1.2×" }
    ]
  },
  {
    key: "fontScale",
    label: "字号",
    hint: "全站文字整体缩放",
    icon: ICONS.type,
    options: [
      { value: "small", label: "小", desc: "93%" },
      { value: "normal", label: "标准", desc: "100%" },
      { value: "large", label: "大", desc: "108%" }
    ]
  },
  {
    key: "width",
    label: "内容宽度",
    hint: "主内容区的最大宽度",
    icon: ICONS.width,
    options: [
      { value: "narrow", label: "窄", desc: "1040px" },
      { value: "normal", label: "标准", desc: "1240px" },
      { value: "wide", label: "宽", desc: "1480px" },
      { value: "full", label: "铺满", desc: "不限" }
    ]
  }
]

const MOTION_OPTIONS = [
  { value: "full", label: "完整", desc: "默认时长" },
  { value: "reduced", label: "减弱", desc: "约一半" },
  { value: "off", label: "关闭", desc: "无动画" }
] as const

const RADIUS_OPTIONS = [
  { value: undefined, label: "主题默认", desc: "" },
  { value: "small", label: "小", desc: "8px" },
  { value: "medium", label: "中", desc: "14px" },
  { value: "large", label: "大", desc: "20px" }
] as const

const BACKDROP_OPTIONS = [
  { value: undefined, label: "主题默认", desc: "" },
  { value: "gradient", label: "渐变", desc: "柔和光晕" },
  { value: "dots", label: "点阵", desc: "细点网格" },
  { value: "plain", label: "纯色", desc: "无装饰" },
  { value: "image", label: "背景图", desc: "主题提供" }
] as const

const SCHEMES: readonly SchemeChoice[] = ["auto", "light", "dark"]

const error = ref("")
const fileInput = ref<HTMLInputElement | null>(null)

/** 当前主题之内存着的改动（未经「主题允许」过滤：置灰的行也要显示它原来存了什么） */
const own = computed<ThemeOverrides>(() => appearance.value.perTheme[currentTheme.value.id] ?? {})
const live = computed(() => effectiveOverrides(appearance.value, { id: currentTheme.value.id, options: currentTheme.value.options, defaultBackdrop: currentTheme.value.backdrop }))
const hasBackdropImage = computed(() => currentTheme.value.slots.backdrop !== undefined)

/**
 * 某色相对应的强调色
 * @param hue 色相
 * @returns CSS 颜色
 */
function accentColor(hue: number): string {
  return `hsl(${hue} 84% 62%)`
}

/**
 * 某一态是否可选：主题只给一套明暗时，另一套与「跟随系统」都不可选
 * @param s 明暗选择
 * @returns 是否可选
 */
function schemeAllowed(s: SchemeChoice): boolean {
  if (supportedSchemes.value.length !== 1) return true
  return s === supportedSchemes.value[0]
}

/**
 * 改一项个人偏好
 * @param key 偏好项
 * @param value 取值
 */
function pickPref(key: keyof AppearancePrefs, value: string): void {
  updatePref(key, value as never)
}

/**
 * 拖动色相滑块
 * @param event 输入事件
 */
function onHue(event: Event): void {
  updateOverride("accentHue", Number((event.target as HTMLInputElement).value))
}

/** 复制当前配置 */
async function copyConfig(): Promise<void> {
  try {
    await copyText(exportAppearance())
    flash("已复制外观配置")
  } catch (err) {
    error.value = errorText(err)
  }
}

/** 存成文件 */
function downloadConfig(): void {
  downloadText("yunzai-appearance.json", exportAppearance())
}

/**
 * 从文件导入
 * @param event 文件框的 change 事件
 */
async function onImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (file === undefined) return
  try {
    if (importAppearance(await file.text())) flash("已导入外观配置")
    else error.value = "文件不是合法的 JSON，未作改动"
  } catch (err) {
    error.value = errorText(err)
  }
}

/**
 * 显示一条回执，并清掉上一次的错误
 * @param text 文案
 */
function flash(text: string): void {
  error.value = ""
  showToast(text)
}
</script>

<template>
  <div>
    <PageHeader route="appearance" sub="主题、明暗与个人偏好，修改即时生效并保存在本浏览器" />

    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="safeMode" class="banner warn">
      安全模式：地址里带着 <code>?theme=safe</code>，所有主题都没有加载。去掉它刷新即回到所选的主题。
    </p>
    <p v-else-if="themeError" class="banner">{{ themeError }}</p>

    <TabBar v-model="tab" :items="TABS" label="外观设置" />

    <Transition name="tab" mode="out-in">
      <!-- ── 主题 ── -->
      <div v-if="tab === 'theme'" key="theme">
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.palette" />选择主题</h2>
          <p class="hint">
            主题换的是一整身皮肤：配色、图标、边框、控件贴图与插图。面板插件的组件与扩展页面也跟着换。
            <a :href="hrefOf('store', { kind: 'theme' })">去面板商店找更多主题 →</a>
          </p>
          <p v-if="!themesLoaded" class="hint">正在读取已装的主题…</p>
          <div class="ap-themes" role="radiogroup" aria-label="主题">
            <button
              v-for="t in themeList"
              :key="t.id"
              type="button"
              role="radio"
              class="ap-theme"
              :class="{ active: currentTheme.id === t.id }"
              :aria-checked="currentTheme.id === t.id"
              :disabled="safeMode"
              @click="chooseTheme(t.id)"
            >
              <span class="ap-theme-art">
                <img v-if="t.preview" :src="t.preview" alt="" loading="lazy" />
                <AppIcon v-else class="ap-theme-none" :path="ICONS.image" />
              </span>
              <span class="ap-theme-info">
                <span class="ap-theme-name">
                  {{ t.name }}
                  <AppIcon v-if="currentTheme.id === t.id" class="btn-ico ap-check" :path="ICONS.check" />
                </span>
                <span class="ap-theme-desc">{{ t.description || "没有说明" }}</span>
                <span class="ap-theme-meta">
                  <span class="tag">{{ t.builtin ? "内置" : t.pkg }}</span>
                  <span v-if="t.schemes.length === 1" class="tag">仅{{ t.schemes[0] === "dark" ? "深色" : "浅色" }}</span>
                  <span v-if="t.script" class="tag warn" title="这款主题带脚本，与面板插件同等信任">带脚本</span>
                </span>
              </span>
            </button>
          </div>
          <p v-if="currentTheme.license" class="hint ap-license">授权：{{ currentTheme.license }}</p>
        </section>

        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.sparkle" />在「{{ currentTheme.name }}」之内调整</h2>
          <p class="hint">只对当前主题生效，换别的主题时各自保存。主题没开放的项不可调。</p>

          <div class="setting-row" :class="{ locked: !currentTheme.options.accentHue }">
            <div class="setting-label">
              <span><AppIcon class="btn-ico" :path="ICONS.palette" />强调色</span>
              <span class="hint">{{ currentTheme.options.accentHue ? "按钮、选中态与进度条的颜色" : "这款主题的配色是定好的，不可改" }}</span>
            </div>
            <div class="setting-control ap-colors">
              <button
                v-for="c in COLOR_PRESETS"
                :key="c.id"
                type="button"
                class="color-dot"
                :class="{ active: currentTheme.options.accentHue && (live.accentHue ?? DEFAULT_ACCENT_HUE) === c.hue }"
                :style="{ background: accentColor(c.hue) }"
                :title="c.name"
                :aria-label="`强调色：${c.name}`"
                :disabled="!currentTheme.options.accentHue"
                @click="updateOverride('accentHue', c.hue)"
              />
              <input
                type="range"
                min="0"
                max="360"
                step="1"
                class="hue-slider"
                aria-label="强调色色相"
                :value="own.accentHue ?? DEFAULT_ACCENT_HUE"
                :disabled="!currentTheme.options.accentHue"
                @input="onHue"
              />
              <button type="button" class="link" :disabled="own.accentHue === undefined" @click="updateOverride('accentHue', undefined)">
                主题默认
              </button>
            </div>
          </div>

          <div class="setting-row" :class="{ locked: !currentTheme.options.radius }">
            <div class="setting-label">
              <span><AppIcon class="btn-ico" :path="ICONS.radius" />圆角</span>
              <span class="hint">卡片、按钮与输入框的圆角</span>
            </div>
            <div class="setting-control" role="radiogroup" aria-label="圆角">
              <button
                v-for="opt in RADIUS_OPTIONS"
                :key="opt.label"
                type="button"
                role="radio"
                class="option-btn"
                :class="{ active: own.radius === opt.value }"
                :aria-checked="own.radius === opt.value"
                :disabled="!currentTheme.options.radius"
                @click="updateOverride('radius', opt.value)"
              >
                <span class="option-label">{{ opt.label }}</span>
                <span v-if="opt.desc" class="option-desc">{{ opt.desc }}</span>
              </button>
            </div>
          </div>

          <div class="setting-row" :class="{ locked: !currentTheme.options.backdrop }">
            <div class="setting-label">
              <span><AppIcon class="btn-ico" :path="ICONS.image" />背景</span>
              <span class="hint">页面底层的装饰；低功耗模式下一律只留底色</span>
            </div>
            <div class="setting-control" role="radiogroup" aria-label="背景">
              <button
                v-for="opt in BACKDROP_OPTIONS"
                v-show="opt.value !== 'image' || hasBackdropImage"
                :key="opt.label"
                type="button"
                role="radio"
                class="option-btn"
                :class="{ active: own.backdrop === opt.value }"
                :aria-checked="own.backdrop === opt.value"
                :disabled="!currentTheme.options.backdrop"
                @click="updateOverride('backdrop', opt.value)"
              >
                <span class="option-label">{{ opt.label }}</span>
                <span v-if="opt.desc" class="option-desc">{{ opt.desc }}</span>
              </button>
            </div>
          </div>

          <div class="actions">
            <button type="button" @click="resetOverrides()"><AppIcon class="btn-ico" :path="ICONS.refresh" />撤销本主题内的调整</button>
          </div>
        </section>
      </div>

      <!-- ── 明暗 ── -->
      <div v-else-if="tab === 'scheme'" key="scheme">
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="SCHEME_ICON[schemeChoice]" />明暗</h2>
          <p class="hint">
            「跟随系统」随操作系统的深浅设置切换。明暗与主题无关：换主题不动这里的选择。
            <template v-if="supportedSchemes.length === 1">
              当前主题只有{{ supportedSchemes[0] === "dark" ? "深色" : "浅色" }}一套，换一款主题后才能切换。
            </template>
          </p>
          <div class="ap-schemes" role="radiogroup" aria-label="明暗">
            <button
              v-for="s in SCHEMES"
              :key="s"
              type="button"
              role="radio"
              class="ap-scheme"
              :class="[`ap-scheme-${s}`, { active: schemeChoice === s }]"
              :aria-checked="schemeChoice === s"
              :disabled="!schemeAllowed(s)"
              @click="setScheme(s)"
            >
              <span class="ap-scheme-art" aria-hidden="true"><i></i><i></i></span>
              <span class="ap-scheme-label"><AppIcon class="btn-ico" :path="SCHEME_ICON[s]" />{{ SCHEME_LABEL[s] }}</span>
            </button>
          </div>
        </section>
      </div>

      <!-- ── 版式 ── -->
      <div v-else-if="tab === 'layout'" key="layout">
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.layers" />版式</h2>
          <p class="hint">个人偏好：跟着人走，换哪款主题都保留。</p>
          <div v-for="s in PREF_SEGMENTS" :key="s.key" class="setting-row">
            <div class="setting-label">
              <span><AppIcon class="btn-ico" :path="s.icon" />{{ s.label }}</span>
              <span class="hint">{{ s.hint }}</span>
            </div>
            <div class="setting-control" role="radiogroup" :aria-label="s.label">
              <button
                v-for="opt in s.options"
                :key="opt.value"
                type="button"
                role="radio"
                class="option-btn"
                :class="{ active: appearance.prefs[s.key] === opt.value }"
                :aria-checked="appearance.prefs[s.key] === opt.value"
                @click="pickPref(s.key, opt.value)"
              >
                <span class="option-label">{{ opt.label }}</span>
                <span class="option-desc">{{ opt.desc }}</span>
              </button>
            </div>
          </div>
        </section>
      </div>

      <!-- ── 动效 ── -->
      <div v-else-if="tab === 'motion'" key="motion">
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.motion" />动效</h2>
          <div class="setting-row">
            <div class="setting-label">
              <span>过渡与入场动画</span>
              <span class="hint">系统要求减少动效时始终从简</span>
            </div>
            <div class="setting-control" role="radiogroup" aria-label="动效">
              <button
                v-for="opt in MOTION_OPTIONS"
                :key="opt.value"
                type="button"
                role="radio"
                class="option-btn"
                :class="{ active: appearance.prefs.motion === opt.value }"
                :aria-checked="appearance.prefs.motion === opt.value"
                @click="pickPref('motion', opt.value)"
              >
                <span class="option-label">{{ opt.label }}</span>
                <span class="option-desc">{{ opt.desc }}</span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label">
              <span>低功耗</span>
              <span class="hint">关掉背景动画、光斑与背景大图，主题脚本也会停下常驻动画。手机与 Termux 上推荐打开</span>
            </div>
            <div class="setting-control">
              <label class="switch">
                <input type="checkbox" :checked="appearance.prefs.lowPower" aria-label="低功耗" @change="updatePref('lowPower', ($event.target as HTMLInputElement).checked)" />
                <span class="switch-track"></span>
              </label>
            </div>
          </div>
        </section>
      </div>

      <!-- ── 备份 ── -->
      <div v-else key="backup">
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.download" />导出与导入</h2>
          <p class="hint">一份 JSON，含所选主题、明暗之外的全部偏好与各主题之内的调整。旧版导出的文件也认。</p>
          <div class="row">
            <button type="button" @click="void copyConfig()"><AppIcon class="btn-ico" :path="ICONS.copy" />复制配置</button>
            <button type="button" @click="downloadConfig()"><AppIcon class="btn-ico" :path="ICONS.download" />导出文件</button>
            <button type="button" @click="fileInput?.click()"><AppIcon class="btn-ico" :path="ICONS.file" />导入文件</button>
            <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="void onImport($event)" />
          </div>
        </section>
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.refresh" />恢复默认</h2>
          <p class="hint">「恢复个人偏好」只动版式与动效；「全部恢复」连主题也换回经典、撤掉每款主题之内的调整。</p>
          <div class="row">
            <button type="button" @click="resetPrefs(); flash('已恢复个人偏好')">恢复个人偏好</button>
            <button type="button" class="danger" @click="resetAppearance(); flash('已全部恢复默认')">全部恢复</button>
          </div>
          <p class="hint">
            主题把外观页遮住、点不到东西时：在地址后加 <code>?theme=safe</code> 打开，所有主题都不加载。
          </p>
        </section>
      </div>
    </Transition>
  </div>
</template>

<!-- 放进 base 层：主题可以换掉本页的样子，与全站其余样式同一待遇 -->
<style scoped>
@layer base {
  h2 {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin: 0 0 var(--s2);
    font-size: var(--fs-h2);
    font-weight: 600;
  }

  .card > .hint {
    margin: 0 0 var(--s4);
  }

  /* ── 主题卡片 ── */
  .ap-themes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
    gap: var(--s3);
  }

  .ap-theme {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    padding: 0;
    overflow: hidden;
    border-width: 2px;
    border-radius: var(--r-card);
    text-align: left;
  }

  .ap-theme.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .ap-theme-art {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    background: var(--raise);
    border-bottom: 1px solid var(--border);
  }

  .ap-theme-art img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .ap-theme-none {
    width: 28px;
    height: 28px;
    color: var(--muted);
  }

  .ap-theme-info {
    display: flex;
    flex-direction: column;
    gap: var(--s1);
    padding: var(--s3);
  }

  .ap-theme-name {
    display: flex;
    align-items: center;
    gap: var(--s1);
    font-weight: 600;
  }

  .ap-check {
    color: var(--accent);
  }

  .ap-theme-desc {
    font-size: var(--fs-hint);
    font-weight: 400;
    color: var(--muted);
  }

  .ap-theme-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1);
    margin-top: var(--s1);
  }

  .ap-license {
    margin: var(--s3) 0 0;
  }

  /* ── 明暗 ── */
  .ap-schemes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s3);
  }

  .ap-scheme {
    flex-direction: column;
    align-items: stretch;
    gap: var(--s2);
    padding: var(--s2);
    border-width: 2px;
  }

  .ap-scheme.active {
    border-color: var(--accent);
    color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  /* 缩略图是对「浅 / 深」本身的示意，取页面底与卡片面两级令牌，按各自的明暗写死成两块 */
  .ap-scheme-art {
    display: flex;
    height: 54px;
    overflow: hidden;
    border-radius: var(--r-ctl);
    border: 1px solid var(--border);
  }

  .ap-scheme-art i {
    flex: 1;
  }

  .ap-scheme-light .ap-scheme-art i,
  .ap-scheme-auto .ap-scheme-art i:first-child {
    background: linear-gradient(180deg, #ffffff 0 30%, #f0f2f5 30%);
  }

  .ap-scheme-dark .ap-scheme-art i,
  .ap-scheme-auto .ap-scheme-art i:last-child {
    background: linear-gradient(180deg, #1a1d27 0 30%, #0f1117 30%);
  }

  .ap-scheme-label {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s1);
    font-size: var(--fs-hint);
  }

  /* ── 设置行 ── */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s3) var(--s4);
    padding: var(--s4) 0;
    border-bottom: 1px solid var(--border);
  }

  .setting-row:last-of-type {
    border-bottom: none;
  }

  .setting-row.locked {
    opacity: 0.55;
  }

  .setting-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 200px;
  }

  .setting-label > span:first-child {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    font-weight: 600;
  }

  .setting-label .hint {
    margin: 0;
  }

  .setting-control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2);
  }

  .option-btn {
    flex-direction: column;
    gap: 0;
    min-width: 72px;
    padding: var(--s2) var(--s3);
  }

  .option-btn.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--panel));
    color: var(--accent);
  }

  .option-label {
    font-size: var(--fs-hint);
  }

  .option-desc {
    font-size: var(--fs-label);
    font-weight: 400;
    color: var(--muted);
  }

  /* ── 强调色 ── */
  .color-dot {
    width: 28px;
    height: 28px;
    min-width: 0;
    padding: 0;
    border: none;
    border-radius: var(--r-pill);
    box-shadow: 0 0 0 3px var(--panel), 0 0 0 4px var(--border);
  }

  .color-dot.active {
    box-shadow: 0 0 0 3px var(--panel), 0 0 0 5px var(--text);
  }

  .hue-slider {
    width: 160px;
    height: 6px;
    padding: 0;
    border: none;
    -webkit-appearance: none;
    appearance: none;
    border-radius: var(--r-pill);
    background: linear-gradient(
      to right,
      hsl(0 84% 62%),
      hsl(60 84% 62%),
      hsl(120 84% 62%),
      hsl(180 84% 62%),
      hsl(240 84% 62%),
      hsl(300 84% 62%),
      hsl(360 84% 62%)
    );
  }

  .hue-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--panel);
    border: 2px solid var(--accent);
    cursor: pointer;
  }

  .hue-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--panel);
    border: 2px solid var(--accent);
    cursor: pointer;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--s3);
  }
}
</style>
