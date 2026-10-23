/**
 * 模块职责：群配置要用的几份清单 —— 命令、有命令的插件、接受群配置的账号；配置页与抽屉共用一次读取
 * 依赖方向：依赖 api 与类型
 * 生命周期：模块级缓存，保留半分钟；之后再取即重读，装卸插件后不至于一直是旧的
 */
import { get } from "./api.js"
import type { AccountItem, AdapterSummary, CommandItem, PluginItem } from "./types.js"

/** 一份清单 */
export interface ScopeLists {
  /** 全部命令 */
  commands: CommandItem[]
  /** 已加载且注册了命令的目录插件名：适配器、渲染器这类没有命令的禁了也没用，不列 */
  plugins: string[]
  /** 同样条件的单文件 JS：装上二三十个是常事，与目录插件分开列 */
  scripts: string[]
  /** 接受群配置的账号：它的适配器由声明了 `groupRules` 的插件提供 */
  accounts: AccountItem[]
}

/** 缓存多久 */
const TTL_MS = 30_000

let cached: { at: number; task: Promise<ScopeLists> } | undefined

/**
 * 取清单
 * @returns 清单
 */
export function loadScopeLists(): Promise<ScopeLists> {
  if (cached !== undefined && Date.now() - cached.at < TTL_MS) return cached.task
  const task = Promise.all([
    get<CommandItem[]>("commands"),
    get<PluginItem[]>("plugins"),
    get<AccountItem[]>("accounts"),
    get<AdapterSummary[]>("adapters")
  ]).then(([commands, plugins, accounts, adapters]) => {
    const able = new Set(adapters.filter(a => a.groupRules === true).map(a => a.id))
    const withCommands = new Set(commands.map(c => c.plugin))
    const usable = plugins.filter(p => p.status === "loaded" && withCommands.has(p.name))
    return {
      commands,
      plugins: usable.filter(p => p.file === undefined).map(p => p.name),
      scripts: usable.filter(p => p.file !== undefined).map(p => p.name),
      accounts: accounts.filter(a => able.has(a.record.adapterId))
    }
  })
  cached = { at: Date.now(), task }
  // 失败的不留着，下次再试
  task.catch(() => (cached = undefined))
  return task
}
