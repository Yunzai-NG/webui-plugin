/**
 * 模块职责：面板插件包配置在浏览器侧的那一份 —— 按包存 schema 与当前值，供组件与配置模态共用
 * 依赖方向：只依赖 vue 的 ref、与类型；不依赖 api，也不认识任何视图
 * 生命周期：模块级单例，装载期由 `panelload.ts` 填入
 * 注意事项：**同一个 `Ref` 被组件与配置模态共用，这就是「改完即生效」的全部实现**：模态保存
 *          成功后写这一份，用到它的组件随之重算。两处各存一份的话，表现是「保存成功了，
 *          但卡片上还是旧的数」。
 *
 *          **schema 一律来自清单，此处只存不算。** node 侧从包的 package.json 里读出它、
 *          填好默认值后经清单送来；浏览器再算一遍默认值就有了两份会走形的默认值。
 *
 *          **「声明错了地方」也存在这里。** schema 写进 `index.js`、或单文件写了
 *          `export const config`，都只表现为「配置按钮没出现」，故那句原因跟着包键存下来，
 *          由插件页写进包详情。
 */
import { ref } from "vue"
import type { Ref } from "vue"
import type { SchemaDescriptor } from "./types.js"

/** 配置读写端点的前缀，与 node 侧 `src/index.ts` 的 `PANEL_CONFIG_ENDPOINT` 对应 */
const CONFIG_SCOPE = "/plugin/webui/panelconfig"

/**
 * 一个包配置端点的地址
 *
 * 包键形如 `panels/hardware`，恰好就是端点里的 `:owner/:name` 两段，故直接拼；两段的字符
 * 已由 node 侧的 `isSafeName` 限定在 `[A-Za-z0-9._-]` 之内，不必转义。
 * @param key 包键
 * @returns 形如 `/plugin/webui/panelconfig/panels/hardware`
 */
export function configUrlOf(key: string): string {
  return `${CONFIG_SCOPE}/${key}`
}

/** 一个包在配置这件事上的全部状况 */
export interface PanelConfigEntry {
  /** 包键，形如 `panels/hardware` */
  key: string
  /** 表单描述；这个包没声明配置项时 undefined */
  schema?: SchemaDescriptor
  /** 当前值，已由 node 侧填过默认值 */
  value: Ref<Record<string, unknown>>
  /**
   * 声明本身有问题时的一句话：写坏了，或写错了地方
   *
   * 与 `schema` 并非互斥：「package.json 里读到了，而 js 里也写了一份」时两者都有，
   * 那时要说的是「js 那份不会被读到」。
   */
  problem?: string
}

const CONFIGS = new Map<string, PanelConfigEntry>()

/**
 * 取一个包的配置记录，没有就现造一条空的
 * @param key 包键
 * @returns 记录
 */
function entryOf(key: string): PanelConfigEntry {
  const found = CONFIGS.get(key)
  if (found !== undefined) return found
  const made: PanelConfigEntry = { key, value: ref<Record<string, unknown>>({}) }
  CONFIGS.set(key, made)
  return made
}

/**
 * 登记一个包的配置声明与当前值
 * @param key 包键
 * @param schema 表单描述
 * @param value 当前值
 */
export function registerPanelConfig(key: string, schema: SchemaDescriptor, value: Record<string, unknown>): void {
  const entry = entryOf(key)
  entry.schema = schema
  entry.value.value = value
}

/**
 * 记下一个包在配置声明上的问题
 * @param key 包键
 * @param reason 面向作者的一句原因，将显示在包详情里
 */
export function notePanelConfigProblem(key: string, reason: string): void {
  entryOf(key).problem = reason
}

/**
 * 取一个包的配置记录
 *
 * **没登记过时给 undefined**，插件页据此决定要不要摆「配置」按钮 —— 摆一个点开是空表单的
 * 按钮比不摆更难解释。
 * @param key 包键
 * @returns 记录；这个包与配置无关时 undefined
 */
export function panelConfigOf(key: string): PanelConfigEntry | undefined {
  return CONFIGS.get(key)
}

/**
 * 取一个包当前配置值的引用，供注入给组件的 `api.config` 用
 *
 * 没登记过也给一个空对象的引用而不抛错：没声明配置的包读 `api.config` 得到空对象是合理的，
 * 抛错会让顺手写了一句 `api.config.value.x` 的组件整格废掉。
 * @param key 包键
 * @returns 值的引用
 */
export function panelConfigValue(key: string): Ref<Record<string, unknown>> {
  return entryOf(key).value
}

/**
 * 写入一份新值（保存成功之后）
 * @param key 包键
 * @param value node 侧归一化后送回的值
 */
export function setPanelConfigValue(key: string, value: Record<string, unknown>): void {
  entryOf(key).value.value = value
}
