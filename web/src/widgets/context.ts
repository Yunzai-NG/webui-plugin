/**
 * 模块职责：内置组件与所在页面之间的注入键
 * 依赖方向：只依赖 vue 的类型与 types 中的响应形状
 * 生命周期：模块级常量
 * 注意事项：**键单独一个文件，为的是避开循环导入**：登记文件要 import 各组件，各组件要 import
 *          注入键；键与登记写在一处则两者互相 import。
 *
 *          **同一页的组件共用页面拉来的那一份数据，不各自发请求。** 概览页七个组件各拉一次
 *          `GET /api/overview`，每 5 秒就是七个请求，且七份分别到达的快照会互相矛盾。
 */
import type { InjectionKey, Ref } from "vue"
import type { AccountItem, LogRecord, Overview, StatsBrief, SystemInfo } from "../types.js"

/**
 * 一路由页面拉来、交给组件的数据
 *
 * 数据与错误并存而非二选一：一次超时不该让已经画出来的列表整片消失，故失败时保留上一次的
 * `data`、只补一条 `error`；组件有数就画数，一次都没拿到过才说明为什么。
 */
export interface Feed<T> {
  /** 最近一次拿到的数据；一次都没拿到过时为 undefined */
  data?: T
  /** 最近一次失败的原因；最近一次成功时为 undefined */
  error?: string
}

/** 概览页拉到的账号列表 */
export const ACCOUNTS: InjectionKey<Ref<Feed<AccountItem[]>>> = Symbol("accounts")

/** 概览页拉到的近期警告与错误，时间升序 */
export const ALERTS: InjectionKey<Ref<Feed<LogRecord[]>>> = Symbol("alerts")

/** 概览页拉到的消息摘要 */
export const MESSAGES: InjectionKey<Ref<Feed<StatsBrief>>> = Symbol("messages")

/** 概览页拉到的快照；尚未拉到时其值为 undefined */
export const OVERVIEW: InjectionKey<Ref<Overview | undefined>> = Symbol("overview")

/**
 * 概览页拉到的系统快照（磁盘与显卡）；尚未拉到时其值为 undefined
 *
 * **与 `OVERVIEW` 分成两个键，因为它们是两个端点**：合成一个的话磁盘探测的耗时会拖住
 * 那六个计数块的刷新，而那六个的数据本已在手。
 */
export const SYSTEM: InjectionKey<Ref<SystemInfo | undefined>> = Symbol("system")
