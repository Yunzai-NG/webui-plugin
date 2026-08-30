/**
 * 模块职责：深浅主题 —— 三态选择（跟随系统 / 浅色 / 深色）与落盘
 * 依赖方向：依赖 vue 的 ref / computed 与 window.matchMedia / localStorage
 * 生命周期：模块级单例；`initTheme()` 在 `main.ts` 里调一次
 * 注意事项：**真正生效的是 `<html data-theme>`，而不是 `prefers-color-scheme`。** 令牌只认那个
 *          属性（见 styles.css 的 `:root[data-theme="dark"]`），故此处把三态**解析成两值**
 *          再写上去 —— 「跟随系统」是本模块的事，样式表不必知道。
 *
 *          **首帧由 index.html 的内联脚本写一次同样的属性。** 少了那一手，深色偏好的使用者
 *          会先看到一帧浅色再跳成深色。两处的键名与取值必须一致。
 *
 *          **`auto` 不写 localStorage，而是删键。** 存一个 `"auto"` 字面值与「没存过」是同一
 *          语义，留着它只是让日后改默认值时钉在旧默认上。
 *
 *          三态而非两态：只给「浅 / 深」的开关一旦点过，就再也回不到跟随系统 —— 而那是
 *          多数人真正想要的状态。
 */
import { computed, ref, watch } from "vue"

/** 主题选择在 localStorage 中的键，与令牌、折叠态同前缀 */
export const THEME_KEY = "yunzai-ng.theme"

/** 使用者的选择 */
export type ThemeChoice = "auto" | "light" | "dark"

/** 实际生效的外观，`auto` 解析之后只剩这两种 */
export type ThemeMode = "light" | "dark"

/** 三态的轮转顺序，也是按钮每次点击的走向 */
const ORDER: readonly ThemeChoice[] = ["auto", "light", "dark"]

/**
 * 把存下来的字符串收成一个合法的选择
 *
 * 认不得的值（改坏了、或旧版留下的）一律退回 `auto`，而不是抛错：这一项坏掉不该让面板打不开。
 * @param raw localStorage 里的原值，没存过时为 null
 * @returns 合法的选择
 */
export function readThemeChoice(raw: string | null): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "auto"
}

/**
 * 解析出实际生效的外观
 * @param choice 使用者的选择
 * @param prefersDark 系统当前是否偏好深色
 * @returns 实际生效的外观
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ThemeMode {
  if (choice === "auto") return prefersDark ? "dark" : "light"
  return choice
}

/**
 * 下一个选择，按 `ORDER` 轮转
 * @param choice 当前选择
 * @returns 下一个选择
 */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  const at = ORDER.indexOf(choice)
  // 兜底取 `auto`：`indexOf` 找不到时给 -1，而 `ORDER[0]` 恰是轮转的起点。
  // 这一支在类型上不可达（形参已是联合类型），写出来只为满足索引访问的可空检查
  return ORDER[(at + 1) % ORDER.length] ?? "auto"
}

/** 系统是否偏好深色；无 matchMedia 的环境（用例）按浅色算 */
const prefersDark = ref(false)

/** 使用者的选择，进程内唯一一份 */
export const themeChoice = ref<ThemeChoice>("auto")

/** 实际生效的外观 */
export const themeMode = computed<ThemeMode>(() => resolveTheme(themeChoice.value, prefersDark.value))

/** 三态各自的按钮文案，与 `aria-label` 同一份 */
export const THEME_LABEL: Record<ThemeChoice, string> = {
  auto: "跟随系统",
  light: "浅色",
  dark: "深色"
}

/**
 * 把外观写到 `<html data-theme>` 上
 * @param mode 实际生效的外观
 */
function apply(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
}

/**
 * 换到下一个选择并落盘
 *
 * `auto` 走删键那一支，理由见文件头。
 */
export function cycleTheme(): void {
  const next = nextTheme(themeChoice.value)
  themeChoice.value = next
  if (next === "auto") localStorage.removeItem(THEME_KEY)
  else localStorage.setItem(THEME_KEY, next)
}

/**
 * 读一次落盘的选择、接上系统偏好的监听，并立即生效
 *
 * **监听一直挂着，不只在 `auto` 时挂**：使用者可能先选了深色、稍后又切回跟随系统，
 * 而那时系统偏好可能已经变过 —— 按需挂载要多记一处「什么时候该补挂」。
 */
export function initTheme(): void {
  themeChoice.value = readThemeChoice(localStorage.getItem(THEME_KEY))

  const media = window.matchMedia("(prefers-color-scheme: dark)")
  prefersDark.value = media.matches
  media.addEventListener("change", event => {
    prefersDark.value = event.matches
  })

  // `immediate` 使首次也走一遍：内联脚本已写过一次，此处覆盖为同一个值，无副作用
  watch(themeMode, apply, { immediate: true })
}
