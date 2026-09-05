<script setup lang="ts">
/**
 * 模块职责：外观设置页 —— 预设方案选择、自定义参数调整
 * 依赖方向：依赖 appearance.ts 的配置系统
 * 生命周期：随所在页面
 * 注意事项：所有修改实时生效，通过 CSS 变量驱动，无需刷新页面
 */
import { computed } from "vue"
import PageHeader from "../components/PageHeader.vue"
import {
  PRESETS,
  currentPreset,
  customValues,
  effectiveValues,
  selectPreset,
  updateCustomValue,
  resetAppearance,
  type AppearanceValues,
  type PresetId
} from "../appearance.js"

/** 预设方案列表 */
const presets = PRESETS

/** 当前选中的预设 */
const selectedPreset = computed<PresetId>({
  get: () => currentPreset.value,
  set: (val) => selectPreset(val)
})

/** 圆角选项 */
const radiusOptions: Array<{ value: AppearanceValues["radius"]; label: string; desc: string }> = [
  { value: "small", label: "小", desc: "8px" },
  { value: "medium", label: "中", desc: "14px" },
  { value: "large", label: "大", desc: "20px" }
]

/** 密度选项 */
const densityOptions: Array<{ value: AppearanceValues["density"]; label: string; desc: string }> = [
  { value: "compact", label: "紧凑", desc: "0.85x" },
  { value: "normal", label: "正常", desc: "1x" },
  { value: "comfortable", label: "舒适", desc: "1.2x" }
]

/** 强调色色相 */
const accentHue = computed<number>({
  get: () => effectiveValues.value.accentHue,
  set: (val) => updateCustomValue("accentHue", val)
})

/** 玻璃拟态效果 */
const glassEffect = computed<boolean>({
  get: () => effectiveValues.value.glassEffect,
  set: (val) => updateCustomValue("glassEffect", val)
})

/** 生成强调色预览 */
function accentColor(hue: number): string {
  return `hsl(${hue}, 84%, 67%)`
}

/** 重置外观 */
function handleReset(): void {
  resetAppearance()
}
</script>

<template>
  <div>
    <PageHeader route="appearance" sub="自定义界面外观，所有修改实时生效" />

    <!-- 预设方案 -->
    <section class="card">
      <h2>预设方案</h2>
      <p class="hint">选择一个预设方案作为基础，再自定义具体参数</p>
      <div class="preset-grid">
        <button
          v-for="preset in presets"
          :key="preset.id"
          class="preset-card"
          :class="{ active: selectedPreset === preset.id }"
          @click="selectedPreset = preset.id"
        >
          <div class="preset-preview" :style="{ background: accentColor(preset.values.accentHue) }">
            <div class="preview-card" :style="{ borderRadius: preset.values.radius === 'small' ? '4px' : preset.values.radius === 'large' ? '10px' : '7px' }"></div>
          </div>
          <div class="preset-info">
            <span class="preset-name">{{ preset.name }}</span>
            <span class="preset-desc">{{ preset.description }}</span>
          </div>
        </button>
      </div>
    </section>

    <!-- 自定义参数 -->
    <section class="card">
      <h2>自定义参数</h2>
      <p class="hint">微调外观细节，覆盖预设中的对应项</p>

      <!-- 圆角 -->
      <div class="setting-row">
        <div class="setting-label">
          <span>圆角大小</span>
          <span class="hint">控制卡片、按钮等元素的圆角</span>
        </div>
        <div class="setting-control">
          <button
            v-for="opt in radiusOptions"
            :key="opt.value"
            class="option-btn"
            :class="{ active: effectiveValues.radius === opt.value }"
            @click="updateCustomValue('radius', opt.value)"
          >
            <span class="option-label">{{ opt.label }}</span>
            <span class="option-desc">{{ opt.desc }}</span>
          </button>
        </div>
      </div>

      <!-- 密度 -->
      <div class="setting-row">
        <div class="setting-label">
          <span>界面密度</span>
          <span class="hint">控制元素间距与内边距</span>
        </div>
        <div class="setting-control">
          <button
            v-for="opt in densityOptions"
            :key="opt.value"
            class="option-btn"
            :class="{ active: effectiveValues.density === opt.value }"
            @click="updateCustomValue('density', opt.value)"
          >
            <span class="option-label">{{ opt.label }}</span>
            <span class="option-desc">{{ opt.desc }}</span>
          </button>
        </div>
      </div>

      <!-- 强调色 -->
      <div class="setting-row">
        <div class="setting-label">
          <span>强调色</span>
          <span class="hint">调整主色调的色相（0-360）</span>
        </div>
        <div class="setting-control color-control">
          <input
            v-model.number="accentHue"
            type="range"
            min="0"
            max="360"
            step="1"
            class="hue-slider"
            :style="{ '--hue': accentHue }"
          />
          <div class="color-preview" :style="{ background: accentColor(accentHue) }"></div>
          <span class="hue-value">{{ accentHue }}°</span>
        </div>
      </div>

      <!-- 玻璃拟态 -->
      <div class="setting-row">
        <div class="setting-label">
          <span>玻璃拟态</span>
          <span class="hint">启用半透明毛玻璃效果（可能影响性能）</span>
        </div>
        <div class="setting-control">
          <button
            class="toggle-btn"
            :class="{ active: glassEffect }"
            @click="updateCustomValue('glassEffect', !glassEffect)"
          >
            <span class="toggle-track">
              <span class="toggle-thumb"></span>
            </span>
            <span class="toggle-label">{{ glassEffect ? "已启用" : "已禁用" }}</span>
          </button>
        </div>
      </div>
    </section>

    <!-- 重置 -->
    <div class="actions">
      <button class="danger" @click="handleReset">重置为默认</button>
    </div>
  </div>
</template>

<style scoped>
h2 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}

.hint {
  margin: 0 0 16px;
  font-size: 12.5px;
  color: var(--muted);
}

/* 预设网格 */
.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.preset-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 2px solid var(--border);
  border-radius: var(--r-card);
  background: var(--panel);
  cursor: pointer;
  transition: all var(--dur-2) var(--ease);
}

.preset-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
}

.preset-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
}

.preset-preview {
  height: 60px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-card {
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.5);
}

.preset-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preset-name {
  font-weight: 600;
  font-size: 14px;
}

.preset-desc {
  font-size: 12px;
  color: var(--muted);
}

/* 设置行 */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.setting-label > span:first-child {
  font-weight: 600;
  font-size: 14px;
}

.setting-control {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* 选项按钮 */
.option-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-ctl);
  background: var(--panel);
  cursor: pointer;
  transition: all var(--dur-1) var(--ease);
}

.option-btn:hover {
  border-color: var(--border-strong);
}

.option-btn.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  color: var(--accent);
}

.option-label {
  font-weight: 600;
  font-size: 13px;
}

.option-desc {
  font-size: 11px;
  color: var(--muted);
}

/* 颜色控制 */
.color-control {
  align-items: center;
  gap: 12px;
}

.hue-slider {
  width: 120px;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  border-radius: 3px;
  background: linear-gradient(to right,
    hsl(0, 84%, 67%),
    hsl(60, 84%, 67%),
    hsl(120, 84%, 67%),
    hsl(180, 84%, 67%),
    hsl(240, 84%, 67%),
    hsl(300, 84%, 67%),
    hsl(360, 84%, 67%)
  );
  outline: none;
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
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.hue-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--panel);
  border: 2px solid var(--accent);
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.color-preview {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid var(--border);
}

.hue-value {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  min-width: 36px;
}

/* 切换按钮 */
.toggle-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
}

.toggle-track {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--border);
  transition: background var(--dur-1) var(--ease);
}

.toggle-btn.active .toggle-track {
  background: var(--accent);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--panel);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform var(--dur-1) var(--ease);
}

.toggle-btn.active .toggle-thumb {
  transform: translateX(16px);
}

.toggle-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}

.toggle-btn.active .toggle-label {
  color: var(--accent);
}

/* 操作区 */
.actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

button.danger {
  color: var(--err);
  border-color: var(--err);
}

button.danger:hover {
  background: color-mix(in srgb, var(--err) 8%, var(--panel));
}
</style>
