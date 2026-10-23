/**
 * 模块职责：群配置的编辑逻辑 —— 读出配置、求某个群当下生效的规则、增删改一条群配置或一个规则组
 * 依赖方向：不依赖任何东西，纯函数
 * 生命周期：无状态
 * 注意事项：形状与内核配置 `scope` 一致，判法与内核 scope.ts 的 `resolveScope` 一致（四档取、同档靠后优先、
 *          规则组找不到退回那条群配置自己那几项）。两边各有用例，改一边要对照着改另一边。
 *
 *          配置里规则组叫 `presets`、群配置叫 `rules`，界面上的名字随产品改过，键名不跟着改。
 *
 *          **写回时整节一起写**：内核的深合并对数组是整体替换，只送改了的那条会把别的规则冲掉。
 */

/** 前缀取哪一份 */
export type PrefixMode = "inherit" | "custom" | "none"

/** 一套前缀与禁用 */
export interface ScopeBody {
  /** 前缀取哪一份 */
  prefixMode: PrefixMode
  /** `custom` 时的前缀，带上任意一个即可 */
  prefix: string[]
  /** 是否单独设禁用 */
  ownDisabled: boolean
  /** 单独设时的禁用项 */
  disabled: string[]
}

/** 规则组 */
export interface ScopePreset extends ScopeBody {
  /** 名字 */
  name: string
}

/** 一条群规则 */
export interface ScopeRule extends ScopeBody {
  /** 机器人账号；`*` 为所有账号 */
  account: string
  /** 群号；空数组为这个账号的全部群 */
  groups: string[]
  /** 套用的规则组名；空串用本条自己那几项 */
  preset: string
}

/** 内核配置里的 `scope` */
export interface ScopeConfig {
  /** 全局群前缀，带上任意一个即可 */
  prefix: string[]
  /** 全局禁用 */
  disabled: string[]
  /** 规则组 */
  presets: ScopePreset[]
  /** 群规则 */
  rules: ScopeRule[]
}

/**
 * 取一个字符串数组
 * @param raw 值
 * @returns 数组；不是数组时空
 */
function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").map(x => x.trim()).filter(x => x !== "") : []
}

/**
 * 规整一套前缀与禁用
 * @param r 记录
 * @returns 规整后的
 */
function bodyOf(r: Record<string, unknown>): ScopeBody {
  return {
    prefixMode: r.prefixMode === "custom" || r.prefixMode === "none" ? r.prefixMode : "inherit",
    prefix: typeof r.prefix === "string" ? strings([r.prefix]) : strings(r.prefix),
    ownDisabled: r.ownDisabled === true,
    disabled: strings(r.disabled)
  }
}

/**
 * 取一个对象
 * @param raw 值
 * @returns 对象；不是对象时空对象
 */
function recordOf(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/**
 * 把读回来的配置规整成可编辑的样子
 * @param raw 内核配置里的 `scope`
 * @returns 规整后的配置；旧内核没有这一节时给一份空的
 */
export function scopeOf(raw: unknown): ScopeConfig {
  const record = recordOf(raw)
  const presets = (Array.isArray(record.presets) ? record.presets : [])
    .map(recordOf)
    .filter(p => typeof p.name === "string" && p.name.trim() !== "")
    .map(p => ({ name: String(p.name).trim(), ...bodyOf(p) }))
  const rules = (Array.isArray(record.rules) ? record.rules : []).map(recordOf).map(r => ({
    account: typeof r.account === "string" && r.account.trim() !== "" ? r.account.trim() : "*",
    groups: strings(r.groups),
    preset: typeof r.preset === "string" ? r.preset.trim() : "",
    ...bodyOf(r)
  }))
  return {
    prefix: typeof record.prefix === "string" ? strings([record.prefix]) : strings(record.prefix),
    disabled: strings(record.disabled),
    presets,
    rules
  }
}

/**
 * 新的一条规则，什么都不改写
 * @param account 账号
 * @returns 规则
 */
export function blankRule(account = "*"): ScopeRule {
  return { account, groups: [], preset: "", prefixMode: "inherit", prefix: [], ownDisabled: false, disabled: [] }
}

/**
 * 新的规则组，名字取「组 N」里没被用过的那个
 * @param scope 配置
 * @returns 规则组
 */
export function blankPreset(scope: ScopeConfig): ScopePreset {
  let n = 1
  while (scope.presets.some(p => p.name === `组${n}`)) n += 1
  return { name: `组${n}`, prefixMode: "inherit", prefix: [], ownDisabled: false, disabled: [] }
}

/**
 * 管到某个群的那条规则，判法同内核
 * @param scope 配置
 * @param account 账号
 * @param group 群号
 * @returns 规则；没有时 undefined
 */
export function ruleOf(scope: ScopeConfig, account: string, group: string): ScopeRule | undefined {
  /**
   * 在一档里找，靠后的优先
   * @param acct 账号键
   * @param all 是否找「全部群」
   * @returns 规则
   */
  const find = (acct: string, all: boolean): ScopeRule | undefined =>
    [...scope.rules].reverse().find(r => r.account === acct && (all ? r.groups.length === 0 : r.groups.includes(group)))
  return find(account, false) ?? find("*", false) ?? find(account, true) ?? find("*", true)
}

/**
 * 某个群当下生效的前缀与禁用
 * @param scope 配置
 * @param account 账号
 * @param group 群号
 * @returns 前缀与禁用项
 */
export function effectiveOf(scope: ScopeConfig, account: string, group: string): { prefix: string[]; disabled: string[] } {
  const rule = ruleOf(scope, account, group)
  const body: ScopeBody | undefined = rule === undefined ? undefined : (scope.presets.find(p => p.name === rule.preset) ?? rule)
  let prefix = scope.prefix
  if (body?.prefixMode === "custom") prefix = body.prefix
  else if (body?.prefixMode === "none") prefix = []
  return { prefix: [...prefix], disabled: body?.ownDisabled === true ? body.disabled : scope.disabled }
}

/**
 * 一套前缀与禁用说成一句话
 * @param body 群配置或规则组
 * @param scope 配置，取全局值
 * @returns 如「前缀「小云」 · 禁用 2 项」
 */
export function bodyText(body: ScopeBody, scope: ScopeConfig): string {
  const prefix =
    body.prefixMode === "custom"
      ? body.prefix.length === 0
        ? "前缀未填"
        : `前缀 ${prefixText(body.prefix)}`
      : body.prefixMode === "none"
        ? "不要前缀"
        : scope.prefix.length === 0
          ? "前缀沿用全局（不要）"
          : `前缀沿用全局 ${prefixText(scope.prefix)}`
  const disabled = body.ownDisabled ? (body.disabled.length === 0 ? "一个不禁" : `禁用 ${body.disabled.length} 项`) : "禁用沿用全局"
  return `${prefix} · ${disabled}`
}

/**
 * 几个前缀写成一串
 * @param list 前缀
 * @returns 如「小云」「阿云」
 */
export function prefixText(list: readonly string[]): string {
  return list.map(p => `「${p}」`).join("")
}

/**
 * 改名一个规则组，引用它的群配置跟着改
 * @param scope 配置
 * @param from 旧名
 * @param to 新名
 * @returns 新配置
 */
export function renamePreset(scope: ScopeConfig, from: string, to: string): ScopeConfig {
  return {
    ...scope,
    presets: scope.presets.map(p => (p.name === from ? { ...p, name: to } : p)),
    rules: scope.rules.map(r => (r.preset === from ? { ...r, preset: to } : r))
  }
}

/**
 * 删一个规则组；引用它的群配置改用它当时的那几项，免得那些群一下子回到全局
 * @param scope 配置
 * @param name 规则组名
 * @returns 新配置
 */
export function removePreset(scope: ScopeConfig, name: string): ScopeConfig {
  const preset = scope.presets.find(p => p.name === name)
  return {
    ...scope,
    presets: scope.presets.filter(p => p.name !== name),
    rules: scope.rules.map(r =>
      r.preset === name && preset !== undefined
        ? { ...r, preset: "", prefixMode: preset.prefixMode, prefix: [...preset.prefix], ownDisabled: preset.ownDisabled, disabled: [...preset.disabled] }
        : r
    )
  }
}
