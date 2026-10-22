/**
 * 模块职责：明暗 —— 三态选择（跟随系统 / 浅色 / 深色）与落盘
 * 依赖方向：依赖 vue 的 ref / computed 与 window.matchMedia / localStorage
 * 生命周期：模块级单例；`initScheme()` 在 `main.ts` 里调一次
 * 注意事项：**明暗不是主题。** 主题是一整身皮肤（见 themes.ts），明暗只是其中一个维度：
 *          同一款主题有浅、深两套取值，换主题不动明暗，换明暗不动主题。
 *
 *          **真正生效的是 `<html data-scheme>`，而不是 `prefers-color-scheme`。** 令牌只认那个
 *          属性（见 styles.css），故此处把三态**解析成两值**再写上去 —— 「跟随系统」是本模块的事，
 *          样式表不必知道。旧名 `data-theme` 同时写着、取值相同，给照旧文档写的第三方样式。
 *
 *          **首帧由 index.html 的内联脚本写一次同样的属性。** 少了那一手，深色偏好的使用者
 *          会先看到一帧浅色再跳成深色。两处的键名与取值必须一致。键名仍是 `yunzai-ng.theme`：
 *          改名会让每个人选过的明暗丢一次。
 *
 *          **`auto` 不写 localStorage，而是删键。** 存一个 `"auto"` 字面值与「没存过」是同一
 *          语义，留着它只是让日后改默认值时钉在旧默认上。
 *
 *          三态而非两态：只给「浅 / 深」的开关一旦点过，就再也回不到跟随系统 —— 而那是
 *          多数人真正想要的状态。
 */
import { computed, ref, watch } from "vue"

/** 明暗选择在 localStorage 中的键；名字沿用旧的，理由见文件头 */
export const SCHEME_KEY = "yunzai-ng.theme"

/** 使用者的选择 */
export type SchemeChoice = "auto" | "light" | "dark"

/** 实际生效的明暗，`auto` 解析之后只剩这两种 */
export type SchemeMode = "light" | "dark"

/** 三态的轮转顺序，也是按钮每次点击的走向 */
const ORDER: readonly SchemeChoice[] = ["auto", "light", "dark"]

/**
 * 把存下来的字符串收成一个合法的选择
 *
 * 认不得的值（改坏了、或旧版留下的）一律退回 `auto`，而不是抛错：这一项坏掉不该让面板打不开。
 * @param raw localStorage 里的原值，没存过时为 null
 * @returns 合法的选择
 */
export function readSchemeChoice(raw: string | null): SchemeChoice {
  return raw === "light" || raw === "dark" ? raw : "auto"
}

/**
 * 解析出实际生效的明暗
 * @param choice 使用者的选择
 * @param prefersDark 系统当前是否偏好深色
 * @returns 实际生效的明暗
 */
export function resolveScheme(choice: SchemeChoice, prefersDark: boolean): SchemeMode {
  if (choice === "auto") return prefersDark ? "dark" : "light"
  return choice
}

/**
 * 下一个选择，按 `ORDER` 轮转
 * @param choice 当前选择
 * @returns 下一个选择
 */
export function nextScheme(choice: SchemeChoice): SchemeChoice {
  const at = ORDER.indexOf(choice)
  // 兜底取 `auto`：`indexOf` 找不到时给 -1，而 `ORDER[0]` 恰是轮转的起点
  return ORDER[(at + 1) % ORDER.length] ?? "auto"
}

/**
 * 主题只给一套明暗时，实际该用哪一套
 *
 * 使用者选了深色、而主题只有浅色时，就用浅色 —— 强行套深色令牌会得到一套没人设计过的颜色。
 * 外观页据同一个函数把不可用的那一态置灰。
 * @param wanted 本该生效的明暗
 * @param supported 主题支持的明暗；空数组按两套都支持算
 * @returns 实际生效的明暗
 */
export function fitScheme(wanted: SchemeMode, supported: readonly SchemeMode[]): SchemeMode {
  if (supported.length === 0 || supported.includes(wanted)) return wanted
  return supported[0] ?? wanted
}

/** 系统是否偏好深色；无 matchMedia 的环境（用例）按浅色算 */
const prefersDark = ref(false)

/** 使用者的选择，进程内唯一一份 */
export const schemeChoice = ref<SchemeChoice>("auto")

/** 当前主题支持的明暗，由 themes.ts 在换主题时写入 */
export const supportedSchemes = ref<readonly SchemeMode[]>(["light", "dark"])

/** 实际生效的明暗 */
export const schemeMode = computed<SchemeMode>(() =>
  fitScheme(resolveScheme(schemeChoice.value, prefersDark.value), supportedSchemes.value)
)

/** 三态各自的按钮文案，与 `aria-label` 同一份 */
export const SCHEME_LABEL: Record<SchemeChoice, string> = {
  auto: "跟随系统",
  light: "浅色",
  dark: "深色"
}

/**
 * 写到 `<html data-scheme>` 上，旧名 `data-theme` 一并写
 * @param mode 实际生效的明暗
 */
function apply(mode: SchemeMode): void {
  const root = document.documentElement
  root.dataset.scheme = mode
  root.dataset.theme = mode
}

/** 换到下一个选择并落盘 */
export function cycleScheme(): void {
  setScheme(nextScheme(schemeChoice.value))
}

/**
 * 直接选定一态并落盘
 *
 * 浏览器禁止本地存储时只在本次会话内生效，不抛错。
 * @param choice 选择
 */
export function setScheme(choice: SchemeChoice): void {
  schemeChoice.value = choice
  try {
    if (choice === "auto") localStorage.removeItem(SCHEME_KEY)
    else localStorage.setItem(SCHEME_KEY, choice)
  } catch {
    // 只影响「下次打开还记得」
  }
}

/**
 * 读一次落盘的选择、接上系统偏好的监听，并立即生效
 *
 * **监听一直挂着，不只在 `auto` 时挂**：使用者可能先选了深色、稍后又切回跟随系统，
 * 而那时系统偏好可能已经变过 —— 按需挂载要多记一处「什么时候该补挂」。
 */
export function initScheme(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SCHEME_KEY)
  } catch {
    raw = null
  }
  schemeChoice.value = readSchemeChoice(raw)

  const media = window.matchMedia("(prefers-color-scheme: dark)")
  prefersDark.value = media.matches
  media.addEventListener("change", event => {
    prefersDark.value = event.matches
  })

  // `immediate` 使首次也走一遍：内联脚本已写过一次，此处覆盖为同一个值，无副作用
  watch(schemeMode, apply, { immediate: true })
}
