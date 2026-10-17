/**
 * 模块职责：数据库页与其三个页签共用的上下文，及概览、SQLite 两个页签都要发的请求
 * 依赖方向：依赖 vue、api 与 types
 * 生命周期：上下文随数据库页，由它 provide、各页签 inject
 * 注意事项：注入键单独一个文件，避开页面与页签组件之间的循环导入
 */
import { inject, type InjectionKey, type Ref } from "vue"
import { post } from "./api.js"
import type { SqlResult } from "./types.js"

/** 数据库页交给各页签的共用状态 */
export interface DbPageContext {
  /** 页头横幅里的错误；空串为无 */
  error: Ref<string>
  /** 是否有请求在途 */
  busy: Ref<boolean>
  /** 面板是否只读，由各页签取数后回填 */
  readonly: Ref<boolean>
  /** 复制一段文本并提示结果；`what` 是提示里对这段文本的称呼 */
  copy: (text: string, what: string) => Promise<void>
}

/** 数据库页上下文的注入键 */
export const DB_PAGE: InjectionKey<DbPageContext> = Symbol("db-page")

/**
 * 取数据库页的上下文
 * @returns 上下文
 */
export function useDbPage(): DbPageContext {
  const ctx = inject(DB_PAGE)
  if (ctx === undefined) throw new Error("数据库页的页签组件只能用在 DatabaseView 里")
  return ctx
}

/**
 * 把 `插件/库名` 拼成路径段
 * @param key 库键
 * @returns 已转义的路径
 */
export function dbPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/")
}

/**
 * 在指定库上执行一条语句
 * @param key 库键
 * @param text SQL
 * @param params 绑定参数
 * @param limit 行数上限
 * @returns 执行结果
 */
export function execOn(key: string, text: string, params: (string | number | null)[], limit: number): Promise<SqlResult> {
  return post<SqlResult>(`storage/sql/${dbPath(key)}/query`, { sql: text, params, limit })
}
