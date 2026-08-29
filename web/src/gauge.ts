/**
 * 模块职责：进度条的取值 —— 比例、着色档位、环形的几何量、百分数文案
 * 依赖方向：无依赖，全为纯函数
 * 生命周期：模块级常量与纯函数
 * 注意事项：**几何与着色都在这里，不在组件里**：两者算错都不报错，只表现为「环画得不对」
 *          或「快满了却还是灰的」，非有用例钉住不可。用例跑在 node 环境（无 jsdom），
 *          故须与 SVG 元素分开。
 *
 *          **着色不用主色**：主色在本站表示「当前所在之处」（导航选中项、当前标签），
 *          拿它表示「占用正常」会让概览页出现七处与之无关的主色块。故低占用取中性色，
 *          越过阈值才转 `--warn` / `--err`。
 *
 *          **比例取不到时返回 undefined 而非 0**：0 会画成空环并写「0%」，读起来是
 *          「确实空着」，而实情是「这台机器测不到」。
 */

/** 环的半径，与 viewBox 一同定死；两者须配对使用 */
export const RING_RADIUS = 42

/** 环所在的 viewBox 边长 */
export const RING_VIEWBOX = 100

/** 环的周长 */
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 转 `--warn` 的阈值 */
const WARN_AT = 0.7

/** 转 `--err` 的阈值 */
const ERR_AT = 0.9

/** 着色档位；空串意为中性色 */
export type GaugeLevel = "" | "warn" | "err"

/**
 * 已用 ÷ 总量
 *
 * 总量为 0、负数或非有限数时**没有比例可言**，返回 undefined 而非 0 —— 一个容量为 0 的
 * 挂载点（空光驱）画成「0% 已用」是错的，它压根没有「用了多少」这件事。
 * @param used 已用量
 * @param total 总量
 * @returns 落在 0-1 内的比例；算不出时 undefined
 */
export function ratioOf(used: number, total: number): number | undefined {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return undefined
  return Math.min(1, Math.max(0, used / total))
}

/**
 * 比例 → 着色档位
 * @param ratio 比例（0-1）；undefined 时取中性
 * @returns 档位
 */
export function gaugeLevel(ratio: number | undefined): GaugeLevel {
  if (ratio === undefined) return ""
  if (ratio >= ERR_AT) return "err"
  if (ratio >= WARN_AT) return "warn"
  return ""
}

/**
 * 比例 → 环的 `stroke-dasharray`
 *
 * 前一段是要画出来的弧长，后一段补满剩下的周长。用 dasharray 而非 dashoffset：
 * 后者还需另配一个等于周长的 dasharray，两个值要一起对上才画得对。
 *
 * **后一段由已取整的前一段算出，两段不各自取整**：各自取整时两段之和不再等于周长
 * （0.777 处差 0.09），dash 图案便重复 —— 表现为环上一道发丝般的弧。
 * @param ratio 比例（0-1）；undefined 按 0 画（此时组件本不该画这个环）
 * @returns 形如 `82.9 181.0` 的取值
 */
export function ringDash(ratio: number | undefined): string {
  const filled = Number((RING_CIRCUMFERENCE * Math.min(1, Math.max(0, ratio ?? 0))).toFixed(2))
  return `${filled} ${(RING_CIRCUMFERENCE - filled).toFixed(2)}`
}

/**
 * 比例 → 百分数文案
 *
 * 取整而不留小数：这几个数是用来「扫一眼」的，`31.4%` 与 `31%` 在此没有差别，
 * 而多出的那一位会让数字每次刷新都在跳。
 * @param ratio 比例（0-1）；undefined 时给破折号
 * @returns 形如 `31%` 的文案
 */
export function percent(ratio: number | undefined): string {
  return ratio === undefined ? "—" : `${Math.round(ratio * 100)}%`
}
