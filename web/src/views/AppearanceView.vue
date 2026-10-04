<script setup lang="ts">
/**
 * 模块职责：外观设置页 —— 深浅主题、预设方案、逐项自定义、实时预览与配置的导入导出
 * 依赖方向：依赖 appearance / theme / icons / download 与 AppIcon、PageHeader
 * 生命周期：随所在页面
 * 注意事项：所有修改经 appearance.ts 写成 CSS 变量与 `<html data-*>`，即时生效、自动落盘，本页不另存。
 *          视觉方案与配色方案各管各的参数；细调后对不上任何方案时，该栏高亮「自定义」。
 */
import { computed, ref } from "vue"
import AppIcon from "../components/AppIcon.vue"
import PageHeader from "../components/PageHeader.vue"
import {
  COLOR_PRESETS,
  CUSTOM,
  LAYOUT_PRESETS,
  appearanceValues,
  applyColorPreset,
  applyLayoutPreset,
  colorPresetOf,
  exportAppearance,
  importAppearance,
  layoutPresetOf,
  resetAppearance,
  updateValue,
  type AppearanceValues,
  type LayoutPreset
} from "../appearance.js"
import { copyText, downloadText } from "../download.js"
import { errorText } from "../format.js"
import { ICONS, THEME_ICON } from "../icons.js"
import { THEME_LABEL, setTheme, themeChoice, type ThemeChoice } from "../theme.js"

/** 以分段按钮选择的几项 */
type SegKey = "radius" | "density" | "fontScale" | "width" | "motion" | "backdrop"

/** 一组分段按钮 */
interface Segment {
  key: SegKey
  label: string
  hint: string
  icon: string
  options: { value: AppearanceValues[SegKey]; label: string; desc: string }[]
}

/**
 * 定义一组分段按钮；按参数名约束取值，写错档位在编译期即报错
 * @param key 参数名
 * @param label 名称
 * @param hint 说明
 * @param icon 图标
 * @param options 各档
 * @returns 分段定义
 */
function seg<K extends SegKey>(
  key: K,
  label: string,
  hint: string,
  icon: string,
  options: { value: AppearanceValues[K]; label: string; desc: string }[]
): Segment {
  return { key, label, hint, icon, options }
}

/** 视觉方案管辖的分段项；玻璃拟态是开关，单列 */
const LAYOUT_SEGMENTS: readonly Segment[] = [
  seg("radius", "圆角", "卡片、按钮与输入框的圆角", ICONS.radius, [
    { value: "small", label: "小", desc: "8px" },
    { value: "medium", label: "中", desc: "14px" },
    { value: "large", label: "大", desc: "20px" }
  ]),
  seg("density", "密度", "元素之间的间距与内边距", ICONS.density, [
    { value: "compact", label: "紧凑", desc: "0.85×" },
    { value: "normal", label: "正常", desc: "1×" },
    { value: "comfortable", label: "舒适", desc: "1.2×" }
  ]),
  seg("fontScale", "字号", "全站文字整体缩放", ICONS.type, [
    { value: "small", label: "小", desc: "93%" },
    { value: "normal", label: "标准", desc: "100%" },
    { value: "large", label: "大", desc: "108%" }
  ]),
  seg("width", "内容宽度", "主内容区的最大宽度", ICONS.width, [
    { value: "narrow", label: "窄", desc: "1040px" },
    { value: "normal", label: "标准", desc: "1240px" },
    { value: "wide", label: "宽", desc: "1480px" },
    { value: "full", label: "铺满", desc: "不限" }
  ]),
  seg("backdrop", "背景", "页面底层的装饰", ICONS.image, [
    { value: "gradient", label: "渐变", desc: "柔和光晕" },
    { value: "dots", label: "点阵", desc: "细点网格" },
    { value: "plain", label: "纯色", desc: "无装饰" }
  ])
]

/** 动效是个人偏好，不归任何方案 */
const MOTION_SEGMENT = seg("motion", "动效", "过渡与入场动画；系统要求减少动效时始终从简", ICONS.motion, [
  { value: "full", label: "完整", desc: "默认时长" },
  { value: "reduced", label: "减弱", desc: "约一半" },
  { value: "off", label: "关闭", desc: "无动画" }
])

const THEMES: readonly ThemeChoice[] = ["auto", "light", "dark"]

const notice = ref("")
const error = ref("")
const fileInput = ref<HTMLInputElement | null>(null)

const layoutActive = computed(() => layoutPresetOf(appearanceValues.value))
const colorActive = computed(() => colorPresetOf(appearanceValues.value))
const layoutName = computed(() => LAYOUT_PRESETS.find(p => p.id === layoutActive.value)?.name ?? "自定义")
const colorName = computed(() => COLOR_PRESETS.find(p => p.id === colorActive.value)?.name ?? "自定义")

/**
 * 某色相对应的强调色
 * @param hue 色相
 * @returns CSS 颜色
 */
function accentColor(hue: number): string {
  return `hsl(${hue} 84% 67%)`
}

/**
 * 方案卡片缩略图的圆角
 * @param radius 圆角档位
 * @returns CSS 长度
 */
function previewRadius(radius: AppearanceValues["radius"]): string {
  return radius === "small" ? "4px" : radius === "large" ? "10px" : "7px"
}

/**
 * 视觉方案缩略图的内边距，示意密度
 * @param p 方案
 * @returns CSS 长度
 */
function previewPad(p: LayoutPreset["values"]): string {
  return p.density === "compact" ? "4px" : p.density === "comfortable" ? "9px" : "6px"
}

/**
 * 选一档
 * @param key 参数名
 * @param value 取值
 */
function pick(key: SegKey, value: AppearanceValues[SegKey]): void {
  updateValue(key, value)
}

/**
 * 拖动色相滑块
 * @param event 输入事件
 */
function onHue(event: Event): void {
  updateValue("accentHue", Number((event.target as HTMLInputElement).value))
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

/** 重置为默认 */
function reset(): void {
  resetAppearance()
  flash("已恢复默认外观")
}

let timer: ReturnType<typeof setTimeout> | undefined

/**
 * 显示一条片刻后自行收起的回执
 * @param text 文案
 */
function flash(text: string): void {
  error.value = ""
  notice.value = text
  clearTimeout(timer)
  timer = setTimeout(() => (notice.value = ""), 2400)
}
</script>

<template>
  <div>
    <PageHeader route="appearance" sub="自定义界面外观，修改即时生效并保存在本浏览器">
      <template #actions>
        <button @click="void copyConfig()"><AppIcon class="btn-ico" :path="ICONS.copy" />复制配置</button>
        <button @click="downloadConfig()"><AppIcon class="btn-ico" :path="ICONS.download" />导出</button>
        <button @click="fileInput?.click()"><AppIcon class="btn-ico" :path="ICONS.file" />导入</button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="void onImport($event)" />
      </template>
    </PageHeader>

    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="notice" class="banner ok" role="status">{{ notice }}</p>

    <div class="ap-layout">
      <div class="ap-main">
        <!-- 主题 -->
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="THEME_ICON[themeChoice]" />主题</h2>
          <p class="hint">「跟随系统」随操作系统的深浅设置切换。</p>
          <div class="ap-themes" role="radiogroup" aria-label="主题">
            <button
              v-for="t in THEMES"
              :key="t"
              role="radio"
              :aria-checked="themeChoice === t"
              class="ap-theme"
              :class="[`ap-theme-${t}`, { active: themeChoice === t }]"
              @click="setTheme(t)"
            >
              <span class="ap-theme-art" aria-hidden="true"><i></i><i></i></span>
              <span class="ap-theme-label"><AppIcon class="btn-ico" :path="THEME_ICON[t]" />{{ THEME_LABEL[t] }}</span>
            </button>
          </div>
        </section>

        <!-- 配色方案：只改强调色 -->
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.palette" />配色方案</h2>
          <p class="hint">当前：{{ colorName }}。只改强调色，不动圆角、间距等视觉参数。</p>
          <div class="color-grid" role="radiogroup" aria-label="配色方案">
            <button
              v-for="c in COLOR_PRESETS"
              :key="c.id"
              role="radio"
              :aria-checked="colorActive === c.id"
              class="color-card"
              :class="{ active: colorActive === c.id }"
              @click="applyColorPreset(c.id)"
            >
              <span class="color-dot" :style="{ background: accentColor(c.hue) }"></span>
              <span class="color-name">{{ c.name }}</span>
            </button>
            <div class="color-card is-custom" :class="{ active: colorActive === CUSTOM }" :aria-current="colorActive === CUSTOM">
              <span class="color-dot" :style="{ background: accentColor(appearanceValues.accentHue) }"></span>
              <span class="color-name">自定义</span>
            </div>
          </div>
          <div class="hue-row">
            <input
              type="range"
              min="0"
              max="360"
              step="1"
              class="hue-slider"
              aria-label="强调色色相"
              :value="appearanceValues.accentHue"
              @input="onHue"
            />
            <span class="hue-value">{{ appearanceValues.accentHue }}°</span>
          </div>
        </section>

        <!-- 视觉方案：只改形，不改色 -->
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.layers" />视觉方案</h2>
          <p class="hint">当前：{{ layoutName }}。管圆角、密度、字号、宽度、背景与玻璃拟态，不动配色。</p>
          <div class="preset-grid">
            <button
              v-for="p in LAYOUT_PRESETS"
              :key="p.id"
              class="preset-card"
              :class="{ active: layoutActive === p.id }"
              :aria-pressed="layoutActive === p.id"
              @click="applyLayoutPreset(p.id)"
            >
              <span class="preset-preview">
                <span
                  class="preview-card"
                  :style="{ borderRadius: previewRadius(p.values.radius), padding: previewPad(p.values) }"
                >
                  <i></i><i></i><b :style="{ borderRadius: previewRadius(p.values.radius) }"></b>
                </span>
              </span>
              <span class="preset-info">
                <span class="preset-name">
                  {{ p.name }}
                  <AppIcon v-if="layoutActive === p.id" class="btn-ico preset-check" :path="ICONS.check" />
                </span>
                <span class="preset-desc">{{ p.description }}</span>
              </span>
            </button>
            <div class="preset-card is-custom" :class="{ active: layoutActive === CUSTOM }" :aria-current="layoutActive === CUSTOM">
              <span class="preset-preview">
                <AppIcon class="custom-ico" :path="ICONS.sparkle" />
              </span>
              <span class="preset-info">
                <span class="preset-name">
                  自定义
                  <AppIcon v-if="layoutActive === CUSTOM" class="btn-ico preset-check" :path="ICONS.check" />
                </span>
                <span class="preset-desc">在下方逐项调整后自动归到这里</span>
              </span>
            </div>
          </div>

          <div v-for="s in LAYOUT_SEGMENTS" :key="s.key" class="setting-row">
            <div class="setting-label">
              <span><AppIcon class="btn-ico" :path="s.icon" />{{ s.label }}</span>
              <span class="hint">{{ s.hint }}</span>
            </div>
            <div class="setting-control" role="radiogroup" :aria-label="s.label">
              <button
                v-for="opt in s.options"
                :key="opt.value"
                role="radio"
                :aria-checked="appearanceValues[s.key] === opt.value"
                class="option-btn"
                :class="{ active: appearanceValues[s.key] === opt.value }"
                @click="pick(s.key, opt.value)"
              >
                <span class="option-label">{{ opt.label }}</span>
                <span class="option-desc">{{ opt.desc }}</span>
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <span><AppIcon class="btn-ico" :path="ICONS.layers" />玻璃拟态</span>
              <span class="hint">卡片半透明并模糊背景；低端设备上可能卡顿</span>
            </div>
            <div class="setting-control">
              <button
                class="toggle-btn"
                role="switch"
                :aria-checked="appearanceValues.glassEffect"
                :class="{ active: appearanceValues.glassEffect }"
                @click="updateValue('glassEffect', !appearanceValues.glassEffect)"
              >
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
                <span class="toggle-label">{{ appearanceValues.glassEffect ? "已启用" : "已禁用" }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 动效：个人偏好，不归任何方案 -->
        <section class="card">
          <h2><AppIcon class="btn-ico" :path="ICONS.motion" />动效</h2>
          <div class="setting-row">
            <div class="setting-label">
              <span>{{ MOTION_SEGMENT.label }}</span>
              <span class="hint">{{ MOTION_SEGMENT.hint }}</span>
            </div>
            <div class="setting-control" role="radiogroup" :aria-label="MOTION_SEGMENT.label">
              <button
                v-for="opt in MOTION_SEGMENT.options"
                :key="opt.value"
                role="radio"
                :aria-checked="appearanceValues.motion === opt.value"
                class="option-btn"
                :class="{ active: appearanceValues.motion === opt.value }"
                @click="pick('motion', opt.value)"
              >
                <span class="option-label">{{ opt.label }}</span>
                <span class="option-desc">{{ opt.desc }}</span>
              </button>
            </div>
          </div>
        </section>

        <div class="actions">
          <button class="danger" @click="reset()"><AppIcon class="btn-ico" :path="ICONS.refresh" />恢复默认</button>
        </div>
      </div>

      <!-- 实时预览：直接用全站的类，所见即各页所得 -->
      <aside class="ap-aside">
        <section class="card ap-preview">
          <h2><AppIcon class="btn-ico" :path="ICONS.eye" />预览</h2>
          <p class="hint">下面的控件与各页使用同一套样式。</p>
          <div class="ap-sample">
            <div class="row">
              <button class="primary">主按钮</button>
              <button>次按钮</button>
            </div>
            <div class="row">
              <span class="tag">标签</span>
              <span class="tag ok">正常</span>
              <button class="link">文字链接</button>
            </div>
            <input type="search" placeholder="输入框" aria-label="预览输入框" />
            <div class="bar-slot"><div class="bar-fill" style="width: 62%"></div></div>
            <p class="banner warn">提示条</p>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
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

/* 主栏 + 右侧预览；预览在宽屏钉住，滚动调整时始终看得见效果 */
.ap-layout {
  display: grid;
  gap: var(--s5);
  align-items: start;
}

@media (min-width: 1100px) {
  .ap-layout {
    grid-template-columns: minmax(0, 1fr) 300px;
  }

  .ap-aside {
    position: sticky;
    top: var(--s4);
  }
}

.ap-main {
  min-width: 0;
}

/* ── 主题 ── */
.ap-themes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s3);
}

.ap-theme {
  flex-direction: column;
  align-items: stretch;
  gap: var(--s2);
  padding: var(--s2);
  border-width: 2px;
}

.ap-theme.active {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

/* 缩略图的配色是对「浅 / 深」本身的示意，故例外地写死，而不随当前主题翻转 */
.ap-theme-art {
  display: flex;
  height: 54px;
  overflow: hidden;
  border-radius: var(--r-ctl);
  border: 1px solid var(--border);
}

.ap-theme-art i {
  flex: 1;
}

.ap-theme-light .ap-theme-art i,
.ap-theme-auto .ap-theme-art i:first-child {
  background: linear-gradient(180deg, #ffffff 0 30%, #f0f2f5 30%);
}

.ap-theme-dark .ap-theme-art i,
.ap-theme-auto .ap-theme-art i:last-child {
  background: linear-gradient(180deg, #1a1d27 0 30%, #0f1117 30%);
}

.ap-theme-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s1);
  font-size: var(--fs-hint);
}

/* ── 预设 ── */
.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(180px, 100%), 1fr));
  gap: var(--s3);
}

.preset-card {
  flex-direction: column;
  align-items: stretch;
  gap: var(--s3);
  padding: var(--s3);
  border-width: 2px;
  border-radius: var(--r-card);
  text-align: left;
}

.preset-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.preset-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 64px;
  border-radius: var(--r-ctl);
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, var(--panel)));
}

/* 「自定义」只是状态指示，不可点；用 div 画成与方案卡同形 */
.is-custom {
  display: flex;
  border: 2px dashed var(--border);
  background: var(--panel);
  color: var(--muted);
}

.is-custom.active {
  border-style: solid;
  color: var(--text);
}

.is-custom .preset-preview {
  background: var(--raise);
}

.custom-ico {
  width: 24px;
  height: 24px;
  color: var(--muted);
}

.is-custom.active .custom-ico {
  color: var(--accent);
}

/* ── 配色方案 ── */
.color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(96px, 100%), 1fr));
  gap: var(--s2);
}

.color-card {
  flex-direction: column;
  align-items: center;
  gap: var(--s2);
  padding: var(--s3) var(--s2);
  border-width: 2px;
  border-radius: var(--r-card);
  box-shadow: none;
}

.color-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.color-dot {
  width: 28px;
  height: 28px;
  border-radius: var(--r-pill);
  box-shadow: 0 0 0 3px var(--panel), 0 0 0 4px var(--border);
}

.color-name {
  font-size: var(--fs-hint);
}

.hue-row {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin-top: var(--s4);
}

.hue-row .hue-slider {
  flex: 1;
  width: auto;
}

.preview-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 64px;
  padding: 6px;
  background: rgb(255 255 255 / 35%);
  border: 1px solid rgb(255 255 255 / 55%);
}

.preview-card i {
  height: 4px;
  border-radius: 2px;
  background: rgb(255 255 255 / 75%);
}

.preview-card i:nth-child(2) {
  width: 60%;
}

.preview-card b {
  align-self: flex-end;
  width: 22px;
  height: 8px;
  background: rgb(255 255 255 / 90%);
}

.preset-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.preset-name {
  display: flex;
  align-items: center;
  gap: var(--s1);
  font-weight: 600;
  font-size: var(--fs-body);
}

.preset-check {
  color: var(--accent);
}

.preset-desc {
  font-size: var(--fs-label);
  font-weight: 400;
  color: var(--muted);
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

.setting-row:last-child {
  border-bottom: none;
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
  gap: var(--s2);
}

.option-btn {
  flex-direction: column;
  gap: 0;
  min-width: 72px;
  padding: var(--s2) var(--s3);
  box-shadow: none;
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

/* ── 色相滑块 ── */
.hue-slider {
  width: 140px;
  height: 6px;
  padding: 0;
  border: none;
  -webkit-appearance: none;
  appearance: none;
  border-radius: var(--r-pill);
  background: linear-gradient(
    to right,
    hsl(0 84% 67%),
    hsl(60 84% 67%),
    hsl(120 84% 67%),
    hsl(180 84% 67%),
    hsl(240 84% 67%),
    hsl(300 84% 67%),
    hsl(360 84% 67%)
  );
}

.hue-slider:focus {
  box-shadow: 0 0 0 3px var(--accent-glow);
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

.hue-value {
  min-width: 40px;
  font-family: var(--font-mono);
  font-size: var(--fs-label);
  color: var(--muted);
}

/* ── 开关 ── */
.toggle-btn {
  gap: var(--s2);
  padding: var(--s1);
  border: none;
  background: transparent;
  box-shadow: none;
}

.toggle-btn:hover:not(:disabled) {
  background: transparent;
  box-shadow: none;
}

.toggle-track {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: var(--r-pill);
  background: var(--border-strong);
  transition: background-color var(--dur-1) var(--ease);
}

.toggle-btn.active .toggle-track {
  background: var(--accent-solid);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--panel);
  transition: transform var(--dur-2) var(--ease-spring);
}

.toggle-btn.active .toggle-thumb {
  transform: translateX(16px);
}

.toggle-label {
  font-size: var(--fs-hint);
  color: var(--muted);
}

.toggle-btn.active .toggle-label {
  color: var(--accent);
}

/* ── 预览 ── */
.ap-sample {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
}

.ap-sample .banner {
  margin: 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
