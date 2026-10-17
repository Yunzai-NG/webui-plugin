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
import { ICONS } from "../icons.js"
import { routeOf } from "../router.js"
import type { Overview } from "../types.js"

/**
 * 取某一页的导航图标
 *
 * 账号与插件两块直接借侧栏那两枚：同一个概念在侧栏与概览上长成两样，会读作两件事。
 * @param id 页面标识
 * @returns path 数据；取不到时为空串
 */
const routeIcon = (id: string): string => routeOf(id)?.icon ?? ""

/** 一个计数块 */
export interface StatDef {
  /** 组件标识，全站唯一 */
  id: string
  /** 组件名 */
  title: string
  /** 右侧那枚图标，24×24 网格上的 path 数据 */
  icon: string
  /**
   * 取值
   * @param data 概览快照
   * @returns 显示在大字位置的文本
   */
  value: (data: Overview) => string
  /**
   * 「共几个」，跟在大字后面以小字给出；缺省则只有大字
   *
   * 与大字分开写：「2 / 2」里要读的是前一个数，后一个只是参照，同号同重时两者抢眼神。
   * @param data 概览快照
   * @returns 分母文本
   */
  total?: (data: Overview) => string
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
    icon: routeIcon("accounts"),
    value: data => String(data.counts.online),
    total: data => `/ ${data.counts.accounts}`
  },
  {
    id: "overview.plugins",
    title: "插件已加载",
    icon: routeIcon("plugins"),
    value: data => String(data.counts.plugins - data.counts.pluginsFailed),
    total: data => `/ ${data.counts.plugins}`,
    label: data => (data.counts.pluginsFailed > 0 ? `插件已加载（失败 ${data.counts.pluginsFailed}）` : "插件已加载"),
    bad: data => data.counts.pluginsFailed > 0
  },
  { id: "overview.commands", title: "命令", icon: ICONS.code, value: data => String(data.counts.commands) },
  { id: "overview.tasks", title: "定时任务", icon: ICONS.clock, value: data => String(data.counts.tasks) },
  {
    id: "overview.handled",
    title: "已处理事件",
    icon: ICONS.motion,
    value: data => String(data.pipeline.handled),
    label: data => (data.pipeline.queued > 0 ? `已处理事件（排队 ${data.pipeline.queued}）` : "已处理事件")
  },
  { id: "overview.memory", title: "常驻内存", icon: ICONS.layers, value: data => bytes(data.usage.rss) }
]
