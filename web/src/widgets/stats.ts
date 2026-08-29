/**
 * 模块职责：概览页六个计数块各自取什么值、写什么字
 * 依赖方向：依赖 format 与 types；不认识注册表，也不认识栅格
 * 生命周期：模块级常量
 * 注意事项：**六块的差异只有取值与文案两处，故不做成六个组件** —— 那样「计数块长什么样」
 *          就分散在六处，改一处漏五处。
 *
 *          `label` 与 `title` 分开：`title` 是组件名（编辑态与「添加组件」里显示），恒定不变；
 *          `label` 是块内那行小字，可随数据变化（有排队时写成「已处理事件（排队 3）」），
 *          而组件名不该跟着变。
 */
import { bytes } from "../format.js"
import type { Overview } from "../types.js"

/** 一个计数块 */
export interface StatDef {
  /** 组件标识，全站唯一 */
  id: string
  /** 组件名 */
  title: string
  /**
   * 取值
   * @param data 概览快照
   * @returns 显示在大字位置的文本
   */
  value: (data: Overview) => string
  /**
   * 块内小字，缺省取 `title`
   * @param data 概览快照
   * @returns 小字文本
   */
  label?: (data: Overview) => string
  /**
   * 是否为异常值，为真时大字转错误色
   * @param data 概览快照
   * @returns 是否异常
   */
  bad?: (data: Overview) => boolean
}

/** 六个计数块，声明顺序即概览页上的先后 */
export const STATS: readonly StatDef[] = [
  {
    id: "overview.accounts",
    title: "账号在线",
    value: data => `${data.counts.online} / ${data.counts.accounts}`
  },
  {
    id: "overview.plugins",
    title: "插件已加载",
    value: data => `${data.counts.plugins - data.counts.pluginsFailed} / ${data.counts.plugins}`,
    bad: data => data.counts.pluginsFailed > 0
  },
  { id: "overview.commands", title: "命令", value: data => String(data.counts.commands) },
  { id: "overview.tasks", title: "定时任务", value: data => String(data.counts.tasks) },
  {
    id: "overview.handled",
    title: "已处理事件",
    value: data => String(data.pipeline.handled),
    label: data => (data.pipeline.queued > 0 ? `已处理事件（排队 ${data.pipeline.queued}）` : "已处理事件")
  },
  { id: "overview.memory", title: "常驻内存", value: data => bytes(data.usage.rss) }
]
