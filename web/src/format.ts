/**
 * 模块职责：展示用的格式化 —— 时间、时长、字节、错误文案
 * 依赖方向：仅依赖 api 中的 ApiError
 * 生命周期：纯函数
 * 注意事项：时间一律按**本地时区**格式化。面板是本机工具，看的是本机刚刚发生的事，
 *          显示 UTC 会让判断相对时间需要额外换算。
 */
import { ApiError } from "./api.js"

/**
 * 毫秒时间戳 → `HH:mm:ss.SSS`
 *
 * 精度至毫秒且不含日期：日志按时间顺序连续阅读，每行重复年月日会挤占有信息量的部分。
 * @param time 毫秒时间戳
 * @returns 时间文本
 */
export function clock(time: number): string {
  const d = new Date(time)
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * 毫秒时间戳 → 完整本地时间
 * @param time 毫秒时间戳
 * @returns 时间文本
 */
export function datetime(time: number): string {
  return new Date(time).toLocaleString()
}

/**
 * 毫秒数 → 可读时长
 * @param ms 毫秒
 * @returns 如 `3天4小时`、`12分`、`8秒`
 */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}毫秒`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60}秒`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}小时${min % 60}分`
  return `${Math.floor(hour / 24)}天${hour % 24}小时`
}

/**
 * 字节数 → 可读体积
 * @param size 字节
 * @returns 如 `76.5 MB`
 */
export function bytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit] ?? "B"}`
}

/**
 * 任意抛出物 → 面向用户的一句说明
 *
 * 仅读取 `message`，不附加状态码：`ApiError` 的 message 已是内核面向用户的文案，
 * 再附 `(HTTP 400)` 会使人误认为发生了两个问题。
 * @param err 抛出物
 * @returns 错误文案
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 状态枚举 → 徽标样式类
 * @param status 状态
 * @returns class 名
 */
export function statusClass(status: string): string {
  if (status === "online" || status === "loaded" || status === "done") return "ok"
  if (status === "connecting" || status === "running") return "warn"
  if (status === "error" || status === "failed") return "err"
  return ""
}

/**
 * 状态枚举 → 中文文案
 *
 * `disabled` 与 `offline` 对使用者的含义完全不同（前者为主动停用，后者为无法连接），
 * 仅凭英文单词无法判断应处置何者。
 *
 * 三类状态（账号 / 插件 / 登录会话）共用一张表：其取值互不冲突，拆为三张将在新增状态时
 * 遗漏其中之一。表中取值须与内核的 `AccountStatus` / `PluginStatus` / `LoginStatus`
 * 逐一对应 —— 多写一个不存在的取值不报错，只会成为永不命中的死代码。
 * @param status 状态枚举值
 * @returns 中文文案；表中不存在时原样返回
 */
export function statusText(status: string): string {
  const table: Record<string, string> = {
    /* AccountStatus */
    online: "在线",
    offline: "离线",
    connecting: "连接中",
    disabled: "已停用",
    error: "出错",
    /* PluginStatus：除 loaded 之外的两项与上文同名同义 */
    loaded: "已加载",
    /* LoginStatus */
    running: "进行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }
  return table[status] ?? status
}

/**
 * 内核运行状态枚举 → 中文文案
 *
 * **刻意不并入 `statusText`**：`running` 在登录会话中意为「进行中」，在内核意为「运行中」，
 * 并入同一张表必使其中一处失真。取值须与内核的 `AppStatus` 逐一对应。
 * @param status 状态枚举值
 * @returns 中文文案；表中不存在时原样返回
 */
export function runtimeStatusText(status: string): string {
  const table: Record<string, string> = {
    created: "已创建",
    starting: "启动中",
    running: "运行中",
    stopping: "停止中",
    stopped: "已停止"
  }
  return table[status] ?? status
}
