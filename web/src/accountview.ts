/**
 * 模块职责：账号页的纯函数 —— 按适配器分页签、取一个页签下的账号与会话、登录二维码转 img 地址
 * 依赖方向：仅依赖 types
 * 生命周期：纯函数
 * 注意事项：**适配器不在了，它名下的账号仍要有地方显示。** 插件被卸载后账号记录照旧留着
 *          （装回来就能自动连上），而页签是按已注册的适配器排的 —— 这些账号若没有自己的页签，
 *          页面上就再也看不到、也删不掉它们。故它们归进最后一枚「未注册」页签。
 */
import type { AccountItem, AdapterSummary, LoginSnapshot, LoginStep } from "./types.js"

/**
 * 「未注册」页签的标识
 *
 * 内核不限定适配器 id 的字符，这里取一个 `~` 打头、不会有适配器拿来当 id 的名字。
 */
export const ORPHAN_TAB = "~orphan"

/** 账号页的一枚页签 */
export interface AccountTab {
  /** 适配器 id；「未注册」那枚是 `ORPHAN_TAB` */
  readonly id: string
  /** 文案 */
  readonly label: string
  /** 名下账号数 */
  readonly count: number
}

/**
 * 按适配器排出页签：已注册的按内核给的顺序，名下有账号却未注册的那些合成最后一枚
 * @param adapters 已注册的适配器
 * @param accounts 全部账号
 * @returns 页签
 */
export function accountTabsOf(adapters: readonly AdapterSummary[], accounts: readonly AccountItem[]): AccountTab[] {
  const known = new Set(adapters.map(a => a.id))
  const tabs: AccountTab[] = adapters.map(a => ({
    id: a.id,
    label: a.name,
    count: accounts.filter(acc => acc.record.adapterId === a.id).length
  }))
  const orphans = accounts.filter(acc => !known.has(acc.record.adapterId)).length
  if (orphans > 0) tabs.push({ id: ORPHAN_TAB, label: "未注册的适配器", count: orphans })
  return tabs
}

/**
 * 一枚页签下的账号
 * @param tab 页签标识
 * @param adapters 已注册的适配器
 * @param accounts 全部账号
 * @returns 该页签下的账号，保持原顺序
 */
export function accountsOfTab(
  tab: string,
  adapters: readonly AdapterSummary[],
  accounts: readonly AccountItem[]
): AccountItem[] {
  if (tab !== ORPHAN_TAB) return accounts.filter(acc => acc.record.adapterId === tab)
  const known = new Set(adapters.map(a => a.id))
  return accounts.filter(acc => !known.has(acc.record.adapterId))
}

/**
 * 进页面时该选中哪一枚：地址里点名的那枚还在就选它，否则第一枚
 * @param tabs 页签
 * @param wanted 地址里的 `?adapter=`
 * @returns 页签标识；一枚都没有时空串
 */
export function pickAccountTab(tabs: readonly AccountTab[], wanted: string | undefined): string {
  if (wanted !== undefined && tabs.some(t => t.id === wanted)) return wanted
  return tabs[0]?.id ?? ""
}

/**
 * 一个页签下要摆出来的登录会话：只取这个适配器的
 * @param tab 页签标识
 * @param logins 全部会话
 * @returns 会话
 */
export function loginsOfTab(tab: string, logins: readonly LoginSnapshot[]): LoginSnapshot[] {
  return tab === ORPHAN_TAB ? [] : logins.filter(s => s.adapterId === tab)
}

/**
 * 把登录步骤里的二维码转成 img 可用的 src
 *
 * 只处理 `url` 与 `base64`：`path` 是内核所在主机的绝对路径，浏览器读不到；
 * `buffer` 经 JSON 序列化后成为 `{"0":137,...}`，此处一并还原 ——
 * 渲染器生成的二维码就是这一形态，不还原就显示成一张坏图。
 * @param step 登录步骤
 * @returns img 的 src；无法展示时空串
 */
export function qrSrcOf(step: LoginStep): string {
  if (step.type !== "qrcode") return ""
  const image = step.image as Record<string, unknown>
  const mime = typeof image.mime === "string" ? image.mime : "image/png"
  if (image.kind === "url" && typeof image.url === "string") return image.url
  if (image.kind === "base64" && typeof image.base64 === "string") return `data:${mime};base64,${image.base64}`
  if (image.kind === "buffer" && typeof image.data === "object" && image.data !== null) {
    let binary = ""
    for (const byte of Object.values(image.data as Record<string, number>)) binary += String.fromCharCode(byte)
    return `data:${mime};base64,${btoa(binary)}`
  }
  return ""
}

/**
 * 交互式登录走到第几步，给弹窗里的步骤条用
 *
 * 三步：选登录方式 → 在手机上完成 → 已接入。还没发起会话是第 0 步；会话进行中是第 1 步；
 * 成功是第 3 步（三步全勾）；失败与取消退回第 0 步，让使用者重新选。
 * @param session 弹窗里那个会话；还没发起时 undefined
 * @returns 步骤序号
 */
export function loginStepOf(session: LoginSnapshot | undefined): number {
  if (session === undefined) return 0
  if (session.status === "running") return 1
  return session.status === "done" ? 3 : 0
}
