/**
 * 模块职责：禁用清单的格子 —— 每个插件或单文件 JS 一格，算它禁了多少、落在哪个页签、展开的详情插在哪
 * 依赖方向：只依赖类型
 * 生命周期：纯函数
 * 注意事项：禁用项是插件名或 `插件名:命令名`，与内核 `scope.disabled` 同形
 */
import type { CommandItem } from "./types.js"

/** 一格 */
export interface DisabledTile {
  /** 插件名 */
  name: string
  /** 是否单文件 JS */
  script: boolean
  /** 可见的命令名 */
  cmds: string[]
  /** 整个禁了 */
  whole: boolean
  /** 单独禁了的命令 */
  added: string[]
}

/** 页签 */
export type DisabledTab = "plugins" | "scripts" | "disabled"

/**
 * 某个插件单独禁了的命令
 * @param value 禁用项
 * @param name 插件名
 * @returns 命令名
 */
export function addedOf(value: readonly string[], name: string): string[] {
  return value.filter(key => key.startsWith(`${name}:`)).map(key => key.slice(name.length + 1))
}

/**
 * 排出全部格子：目录插件在前、单文件 JS 在后，各按名字排
 * @param plugins 目录插件名
 * @param scripts 单文件 JS 名
 * @param commands 全部命令
 * @param value 禁用项
 * @returns 格子
 */
export function buildTiles(plugins: readonly string[], scripts: readonly string[], commands: readonly CommandItem[], value: readonly string[]): DisabledTile[] {
  const sorted = (names: readonly string[]) => [...names].sort((a, b) => a.localeCompare(b))
  const tile = (name: string, script: boolean): DisabledTile => ({
    name,
    script,
    cmds: commands.filter(c => c.plugin === name && !c.hidden).map(c => c.name),
    whole: value.includes(name),
    added: addedOf(value, name)
  })
  return [...sorted(plugins).map(n => tile(n, false)), ...sorted(scripts).map(n => tile(n, true))]
}

/**
 * 是否禁了点什么
 * @param tile 格子
 * @returns 整个或单条
 */
export function touched(tile: DisabledTile): boolean {
  return tile.whole || tile.added.length > 0
}

/**
 * 是否匹配筛选：名字或其中一条命令含关键字
 * @param tile 格子
 * @param query 关键字
 * @returns 是否匹配
 */
export function matchesTile(tile: DisabledTile, query: string): boolean {
  const q = query.trim().toLowerCase()
  return q === "" || tile.name.toLowerCase().includes(q) || tile.cmds.some(c => c.toLowerCase().includes(q))
}

/**
 * 某个页签下的格子
 * @param tiles 全部格子
 * @param tab 页签
 * @param query 关键字
 * @returns 格子
 */
export function tilesOf(tiles: readonly DisabledTile[], tab: DisabledTab, query: string): DisabledTile[] {
  return tiles.filter(t => (tab === "disabled" ? touched(t) : t.script === (tab === "scripts")) && matchesTile(t, query))
}

/**
 * 已写进去而清单里没有的项（插件卸了、改名了）
 * @param value 禁用项
 * @param tiles 全部格子
 * @returns 禁用项
 */
export function staleOf(value: readonly string[], tiles: readonly DisabledTile[]): string[] {
  const known = new Set(tiles.map(t => t.name))
  return value.filter(key => !known.has(key.includes(":") ? key.slice(0, key.indexOf(":")) : key))
}

/**
 * 收起时露几格：整行整行地露，免得最后一行半截
 * @param cols 列数
 * @param rows 露几行
 * @param total 总格数
 * @returns 格数；全部放得下时即总数
 */
export function visibleCount(cols: number, rows: number, total: number): number {
  return Math.min(total, Math.max(1, cols) * rows)
}

/**
 * 展开的详情插在哪一格后面：所在那一行的末格，好让详情占满下一整行、紧贴着它
 * @param index 展开那一格的下标
 * @param cols 列数
 * @param shown 露出的格数
 * @returns 下标
 */
export function detailAfter(index: number, cols: number, shown: number): number {
  const per = Math.max(1, cols)
  return Math.min(shown - 1, Math.floor(index / per) * per + per - 1)
}
