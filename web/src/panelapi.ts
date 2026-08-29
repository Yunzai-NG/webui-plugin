/**
 * 模块职责：面板插件的对外契约 —— 插件模块该长什么样，以及注入给它的 `api` 里有什么
 * 依赖方向：依赖 vue 的 h / ref / computed、api 的 getAt、tick、format、gauge
 * 生命周期：`makePanelApi` 在每个插件组件的 setup 里各调一次
 * 注意事项：**给 `h` 不等于给 Vue。** 逐个列出插件能用的东西，故插件拿不到
 *          `createApp` / `defineComponent` / `watch`，也写不出 `.vue`；换渲染层时
 *          只需换掉 `h` 的实现。
 *
 *          **`api` 逐实例构造。** `onTick` 的自动退订要知道「当前是哪个组件」，
 *          而那一上下文只在 setup 执行期间存在。
 *
 *          **`get` 只收绝对路径。** 相对路径按当前页面的路径解析，概览页在 `/` 下时
 *          看着是对的，换到别的路由就成了另一个 URL —— 不报错，只表现为
 *          「换页再回来就没数了」，故直接拒掉。
 */
import { computed, h, onUnmounted, ref } from "vue"
import type { ComputedRef, VNode } from "vue"
import { getAt } from "./api.js"
import { bytes, clock, duration } from "./format.js"
import { gaugeLevel, percent, ratioOf } from "./gauge.js"
import { panelConfigValue } from "./panelconfig.js"
import { onTick } from "./tick.js"

/** 注入给插件的格式化函数，皆为 `format.ts` 与 `gauge.ts` 里已有的纯函数 */
export interface PanelFmt {
  /** 字节数 → 如 `76.5 MB` */
  bytes: typeof bytes
  /** 比例（0-1）→ 如 `31%`；undefined 给破折号 */
  percent: typeof percent
  /** 毫秒数 → 如 `3天4小时` */
  duration: typeof duration
  /** 毫秒时间戳 → `HH:mm:ss.SSS` */
  clock: typeof clock
  /** 已用 ÷ 总量 → 0-1 的比例；算不出时 undefined */
  ratioOf: typeof ratioOf
  /**
   * 比例 → 着色档位类名（`""` / `"warn"` / `"err"`），直接加在元素的 class 上
   *
   * 阈值（0.7 / 0.9）不要抄进插件：抄了之后面板调整档位，插件的槽与内置的槽
   * 会在不同占用率变红，而这种不一致几乎不会被当成 bug 报出来。
   */
  gaugeLevel: typeof gaugeLevel
}

/** 注入给插件 `setup` 的全部能力 */
export interface PanelApi {
  /** Vue 的渲染函数 */
  h: typeof h
  /** 响应式引用 */
  ref: typeof ref
  /** 派生值 */
  computed: typeof computed
  /**
   * 带令牌的 GET
   * @param url 绝对路径，须以 `/` 开头
   * @returns 响应体
   */
  get: <T>(url: string) => Promise<T>
  /**
   * 带令牌的 GET，打到**本包自己那半 node 侧**
   *
   * 基地址由 node 侧算出、经清单送来，故包**不该自己拼前缀** —— 拼在两处会漂移，
   * 表现为全部包的接口一齐 404。没有 node 侧时抛错，而不是静默给一个 undefined。
   * @param path 相对本包的路径，如 `hardware`
   * @returns 响应体
   */
  own: <T>(path: string) => Promise<T>
  /**
   * 订阅共享刷新节拍（5 秒一拍），组件卸载时自动退订
   * @param fn 每拍执行一次
   */
  onTick: (fn: () => void) => void
  /**
   * 登记一份卸载时要做的收尾，组件被移除或换页时执行
   *
   * **给自带计时器、监听器或长连接的组件用。** 共享节拍（`onTick`）已自动退订；
   * 但它是 5 秒一拍的采样节拍，每秒一次的时钟、`resize` 监听这些自己建的东西
   * 就得自己收 —— 不收则组件移除后计时器仍在跑、仍在改一个没人看的 ref。
   * @param fn 卸载时执行一次
   */
  onUnmounted: (fn: () => void) => void
  /**
   * 本包当前的配置值，**只读且响应式**
   *
   * 值由使用者在插件页上填、存在 webui 的数据目录下，声明写在包 package.json 的
   * `webuiPanel.config` 里（单文件插件没有这个能力，见 `panelcheck.ts` 的
   * `checkConfigPlace`）。使用者改完不必刷新页面：这一份与配置模态共用一个引用。
   *
   * 只读：值的落点在 node 侧，往这里写只改动本页副本、下次刷新即消失。要改走面板上那张表单。
   *
   * 没声明配置项的包读到的是空对象，故取值一律要带兜底（`api.config.value.port ?? 6379`）。
   */
  config: ComputedRef<Record<string, unknown>>
  /** 格式化函数 */
  fmt: PanelFmt
}

/**
 * 一个面板插件模块的默认导出
 *
 * 与内置组件的 `WidgetDef` 不同形：那边是一个 vue `Component`，这边是「返回渲染函数的
 * setup」（插件写不出 `.vue`）。两者最终进同一张注册表，转换在 `panelload.ts` 里。
 */
export interface PanelWidget {
  /** 全站唯一标识；落盘的布局按它认位置 */
  id: string
  /** 挂到哪一页，取 `ROUTES` 中的 id */
  page: string
  /** 组件名，在编辑态的把手与「添加组件」里显示 */
  title: string
  /** 默认尺寸与下限 */
  defaultLayout: {
    /** 默认列数 */
    w: number
    /** 默认行数 */
    h: number
    /** 最少列数；`resizable` 为真时必填，否则缺省 1 */
    minW?: number
    /** 最少行数；`resizable` 为真时必填，否则缺省 1 */
    minH?: number
    /**
     * 使用者可否改这一格的大小，缺省为假（尺寸固定）
     *
     * 为真时 `minW` / `minH` **必须一并给出**，否则本组件不加载、只得到一格占位 ——
     * 一枚卡片能缩到多小只有写它的人知道，面板不替它猜。
     */
    resizable?: boolean
  }
  /** 是否默认不上板，改为出现在编辑态的「已移除」一栏里 */
  defaultHidden?: boolean
  /**
   * 建立组件状态并返回渲染函数
   * @param api 注入的能力
   * @returns 渲染函数
   */
  setup: (api: PanelApi) => () => VNode | VNode[] | string | null
}

/**
 * 一个面板插件贡献的插件页页签
 *
 * 与组件同一形制（一个 setup 换一个渲染函数，收同一份 `api`），差别只在去处：组件按
 * `page` 落进某一页的栅格，页签落在插件页那一排标签上、占整块内容区 —— 故页签没有
 * `page` 与 `defaultLayout`。一个包可以在那里摊开整套界面，而不必挤进一张卡片。
 */
export interface PanelTab {
  /** 全站唯一标识；同一标识不许后注册者覆盖，规则同组件 */
  id: string
  /** 页签上的文案 */
  title: string
  /**
   * 建立页签状态并返回渲染函数
   * @param api 注入的能力，与组件收到的是同一份
   * @returns 渲染函数
   */
  setup: (api: PanelApi) => () => VNode | VNode[] | string | null
}

/** 造一份注入用 `api` 所需的两件事，皆由清单给出 */
export interface PanelApiDeps {
  /** 本包 node 侧路由的基地址；包没有 node 侧时省略 */
  apiBase?: string
  /** 本包的包键，形如 `panels/hardware`；省略时 `api.config` 恒为空对象 */
  pkg?: string
}

/**
 * 构造一份注入给插件的 `api`
 *
 * 必须在组件的 setup 执行期间调用：`onUnmounted` 与 `onTick` 的自动退订都依赖
 * 「当前正在 setup 的是哪个组件实例」这一上下文。
 * @param deps 本包的基地址与包键
 * @returns 该组件专用的 api
 */
export function makePanelApi(deps: PanelApiDeps = {}): PanelApi {
  /** 本组件登记过的退订函数 */
  const offs: (() => void)[] = []

  const { apiBase, pkg } = deps
  /* 取一次引用而非每次读都查表；引用不变而里头的值会变，故改了配置照样看得到 */
  const configured = panelConfigValue(pkg ?? "")

  onUnmounted(() => {
    for (const off of offs) off()
    offs.length = 0
  })

  return {
    h,
    ref,
    computed,
    get: async <T>(url: string): Promise<T> => {
      if (!url.startsWith("/")) {
        throw new Error(`面板插件的 get 只接受绝对路径（须以 / 开头），收到的是 ${url}`)
      }
      return getAt<T>(url)
    },
    own: async <T>(path: string): Promise<T> => {
      if (apiBase === undefined) {
        throw new Error(
          "本面板插件没有 node 侧：api.own 只对带 node 侧入口的插件包可用。" +
            "须在 package.json 里声明 webuiPanel.server"
        )
      }
      return getAt<T>(`${apiBase}/${path.replace(/^\/+/, "")}`)
    },
    onTick: (fn: () => void): void => {
      offs.push(onTick(fn))
    },
    /* 与 onTick 共用收尾队列：队列已由顶上的 onUnmounted 一次清空，不必再登记第二个钩子 */
    onUnmounted: (fn: () => void): void => {
      offs.push(fn)
    },
    config: computed(() => configured.value),
    fmt: { bytes, percent, duration, clock, ratioOf, gaugeLevel }
  }
}
