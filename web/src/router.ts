/**
 * 模块职责：哈希路由 —— 把 `location.hash` 解析为当前页面标识与查询参数
 * 依赖方向：仅依赖 vue 的响应式能力与浏览器 API
 * 生命周期：模块级单例，监听器与页面同寿
 * 注意事项：**不引入 vue-router**：面板为单层页面结构，无嵌套路由与路由守卫。
 *
 *          采用哈希而非 History API：1) 哈希不发送至服务端，不可能与 `/api/*` 或插件
 *          注册的路由冲突；2) 面板产物以相对 base 打包（见 vite.config.ts），可挂载于
 *          任意前缀之下，而 History 模式要求在构建期即确定前缀。
 *
 *          查询参数暴露为 `currentQuery`：插件列表跳转至配置页需携带目标配置名
 *          （`#/config?name=adapter-napcat`），丢弃查询串会让跨页跳转只落在第一份配置上。
 */
import { ref, type Ref } from "vue"

/** 页面定义 */
export interface RouteDef {
  /** 哈希中的标识 */
  readonly id: string
  /** 导航文案 */
  readonly label: string
  /** 分组标题，用于在导航中分段 */
  readonly group: string
  /**
   * 页面图标：24×24 网格上的 svg path 数据，描边渲染
   *
   * **不用 Unicode 几何字符**（◉ ◈ ◇ 一类）：Windows 上有数个被系统彩色字体接管，而
   * `color` 对彩色字形无效，侧栏会冒出蓝圈与橙色菱形。
   */
  readonly icon: string
}

/**
 * 全部页面，顺序即导航顺序
 *
 * **图标与文案只在此处书写**，页头与侧栏各自取用同一条记录 —— 分两处写迟早会漂移，
 * 同一个页面在两处长着两副样子。
 */
export const ROUTES: readonly RouteDef[] = [
  // 仪表盘：半圆刻度加一根指针
  { id: "overview", label: "概览", group: "运行状态", icon: "M4 17a8 8 0 1 1 16 0M12 17l4.5-4.5" },
  // 人形：头与肩
  {
    id: "accounts",
    label: "账号",
    group: "运行状态",
    icon: "M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5M5 20a7 7 0 0 1 14 0"
  },
  // 日志行：左侧时间列 + 右侧正文，与日志页实际的分栏同形
  {
    id: "logs",
    label: "日志",
    group: "运行状态",
    icon: "M4 7.5h2.5M9.5 7.5h10.5M4 12h2.5M9.5 12h10.5M4 16.5h2.5M9.5 16.5h7"
  },
  // 模块：一块方板加两条左出的引脚，读作「插上去的东西」
  { id: "plugins", label: "插件", group: "扩展", icon: "M9 5.5h9.5v13H9zM9 9.5H4.5M9 14.5H4.5" },
  // 下载入托盘：市场页做的事是「取来装上」，比店铺或提袋在 18px 下更易辨
  {
    id: "market",
    label: "插件市场",
    group: "扩展",
    icon: "M12 4v10M8 10.5l4 4 4-4M4.5 19h15"
  },
  /*
   * 面板商店：四格方板加一枚右下角的加号，读作「往版面上添一格」
   *
   * 与插件市场的「下载入托盘」刻意不同形：那边装内核插件，这边装往面板上添格子的包，
   * 图标相近会让人以为其中一页是另一页的重复。
   */
  {
    id: "store",
    label: "面板商店",
    group: "扩展",
    icon: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM16.5 14v5M14 16.5h5"
  },
  // 推子：两道滑轨各带一枚旋钮
  {
    id: "config",
    label: "配置",
    group: "设置",
    icon:
      "M4 8.5h8M16 8.5h4M15.75 8.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0" +
      "M4 15.5h4M12 15.5h8M11.75 15.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0"
  },
  // 问号：圆圈 + 钩 + 一点（点由 round 端帽渲染，故写成零长度线段）
  {
    id: "help",
    label: "帮助",
    group: "设置",
    icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9.4 9.3a2.7 2.7 0 0 1 5.2 1c0 1.7-2.6 2.1-2.6 3.9M12 17.2h.01"
  }
]

/** 默认页面 */
const DEFAULT_ROUTE = "overview"

/**
 * 按标识取页面定义
 * @param id 页面标识
 * @returns 页面定义；标识未登记时为 undefined
 */
export function routeOf(id: string): RouteDef | undefined {
  return ROUTES.find(r => r.id === id)
}

/** 解析后的哈希 */
interface ParsedHash {
  /** 页面标识 */
  readonly id: string
  /** 查询参数 */
  readonly query: Record<string, string>
}

/**
 * 解析 `location.hash`
 *
 * 无法识别的页面标识一律退回默认页面：手工输错哈希、或经旧版本的书签进入时，
 * 一张空白页无法说明原因。
 * @returns 页面标识与查询参数
 */
function parseHash(): ParsedHash {
  const raw = location.hash.replace(/^#\/?/, "")
  const cut = raw.indexOf("?")
  const id = cut < 0 ? raw : raw.slice(0, cut)
  const query: Record<string, string> = {}
  if (cut >= 0) {
    for (const [key, value] of new URLSearchParams(raw.slice(cut + 1))) query[key] = value
  }
  return { id: ROUTES.some(r => r.id === id) ? id : DEFAULT_ROUTE, query }
}

/** 当前页面标识 */
export const currentRoute: Ref<string> = ref(parseHash().id)

/** 当前查询参数 */
export const currentQuery: Ref<Record<string, string>> = ref(parseHash().query)

/**
 * 构造一个页面的哈希地址
 *
 * 以锚点而非点击事件实现跳转，可保留中键新开标签页、右键复制链接等原生行为。
 * @param id 页面标识
 * @param query 查询参数
 * @returns 形如 `#/config?name=demo` 的地址
 */
export function hrefOf(id: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString()
  return search === "" ? `#/${id}` : `#/${id}?${search}`
}

window.addEventListener("hashchange", () => {
  const parsed = parseHash()
  currentRoute.value = parsed.id
  currentQuery.value = parsed.query
})
