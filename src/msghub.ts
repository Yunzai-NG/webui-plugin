/**
 * 模块职责：采集器与页面接口之间的交接点 —— 存一个「当前怎么取快照」的函数
 * 依赖方向：只依赖 msgstats 的类型；不 import 采集器，也不 import 内核
 * 生命周期：模块级单实例，随 webui 的加载与卸载置入与清空
 * 注意事项：**为什么要这一层**：接口由 webui 自己的 `webadapter/index.js` 在 `mountCustomPages`
 *          扫描时注册，而采集器在 `setup()` 里启动 —— 两处拿不到彼此的引用，且顺序不保证。
 *          让接口在被调用时才向 hub 取快照，就与「采集器什么时候起来」解耦了：
 *          起来之前访问页面得到的是空数据加一句说明，而不是一个 500。
 *
 *          **不把 `StatsBuckets` 实例放进来，只放一个取快照的函数**：放实例的话接口那侧就能
 *          `add()`，等于开了一条从 HTTP 往统计里写数的路。函数只能读。
 */
import { HOUR_KEEP_DAYS, KEEP_DAYS, dayKey, type StatsDoc } from "./msgstats.js"

/** 取快照的函数，采集器启动时置入 */
type Reader = () => StatsDoc

/** 当前的取数函数；采集器未启动时为 undefined */
let reader: Reader | undefined

/**
 * 登记取数函数，采集器启动后调用
 * @param fn 取快照的函数
 */
export function setStatsReader(fn: Reader): void {
  reader = fn
}

/** 撤下取数函数，采集器停止时调用 */
export function clearStatsReader(): void {
  reader = undefined
}

/** 统计接口的返回体 */
export interface StatsPayload {
  /** 按天分桶的全量数据；采集器未起时是一份空文档 */
  readonly doc: StatsDoc
  /** 采集器是否已在运行；为假时页面应说明「统计尚未开始」而不是显示 0 */
  readonly running: boolean
  /**
   * 服务端本地时区下的「今天」，形如 `2026-09-11`
   *
   * 页面一律以这个值为所有区间的右端，**不用自己的 `new Date()` 推算**。
   */
  readonly today: string
  /**
   * 服务端保留多少天的数据
   *
   * 页面据它给日期控件设下界。不送这一项的话，自定义范围能选到一个必然为空的区间，
   * 而空图表看起来与「那几天真的没人说话」一模一样。
   */
  readonly keepDays: number
  /**
   * 服务端此刻的毫秒时间戳
   *
   * 与 `today` 同一个道理，只是粒度更细：「当日」是服务端当天 00:00 到此刻，「1 日」是
   * 此刻往前 24 小时 —— 两者都要一个**服务端的**此刻。用浏览器的 `Date.now()` 会在时区
   * 不一致时整段错位，且错得看不出来（图照样画得出来，只是首尾各偏几小时）。
   */
  readonly now: number
  /**
   * 小时桶保留多少天
   *
   * 页面据它决定「按小时看」最远能看到哪天：更早的天在裁剪时只剩天汇总，
   * 请求小时粒度只会得到一排 0，而那与「那几小时没人说话」长得一样。
   */
  readonly hourKeepDays: number
}

/**
 * 取一份当前快照
 *
 * 「今天」由服务端算好送出，而不是让页面自己算：iframe 里的 `Date.now()` 走的是**浏览器
 * 所在机器**的时钟与时区，而分桶键用的是**服务端**的本地日期（见 msgstats.ts 的 `dayKey`）。
 * 人在国外看家里的机器人时，两者能差一整天 —— 页面按自己的「今天」去查会整段错位，
 * 而且错得看不出来：数据都在，只是首尾各差一天，图表照样画得出来。
 * @returns 快照与运行状态
 */
export function readStats(): StatsPayload {
  const now = Date.now()
  const today = dayKey(now)
  const base = { today, now, keepDays: KEEP_DAYS, hourKeepDays: HOUR_KEEP_DAYS }
  if (reader === undefined) return { doc: { version: 2, days: {} }, running: false, ...base }
  return { doc: reader(), running: true, ...base }
}
