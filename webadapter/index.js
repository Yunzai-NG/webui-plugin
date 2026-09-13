/**
 * 模块职责：webui 自己的自定义页面入口 —— 注册「消息统计」页，并开出它的取数接口
 * 依赖方向：只依赖 dist 里的 msghub；不 import 内核，也不认识采集器
 * 生命周期：由 `mountCustomPages` 在扫描到本目录时 import 一次并调 `init`
 * 注意事项：**webui 用自己那套机制给自己开页面**，与任何第三方插件一视同仁：同一份清单、
 *          同一道数据桥、同一个 `/custom/<插件名>/` 前缀。这不只是好看 —— 机制若对自己
 *          都不够用，对别人也不会够用。
 *
 *          接口地址里的插件名由 `registerApi` 按**真实目录名**拼，故不在此处硬编码。
 *          安装目录被改名（`webui` → `webui-plugin`）时页面照旧取得到；若在 index.ts 里
 *          写死 `/custom/webui/api/stats`，改名后页面能打开但取数 404，且毫无提示。
 *
 *          取数走 msghub 而非直接摸采集器：本文件被 import 的时刻与采集器启动的时刻
 *          相互不保证，hub 让接口在**被调用时**才取快照（见 src/msghub.js 的说明）。
 */
import { readStats } from "../dist/msghub.js"

/**
 * 注册页面与接口
 * @param {object} ctx 自定义页面上下文
 * @param {(page: object) => void} ctx.registerPage 注册本插件页面
 * @param {(path: string, handler: () => unknown) => void} ctx.registerApi 注册只读接口
 */
export function init(ctx) {
  ctx.registerPage({
    title: "消息统计",
    sub: "收发消息、图片与表情包的计数与趋势",
    provider: "WebUI",
    // 只给几何，颜色由面板给（描边取 currentColor，故跟着主题走）——
    // 这也是第三方插件该走的路，webui 自己先用一遍
    icon: "M4 20V10M10 20V4M16 20v-7M21 20H3"
  })

  // 一次返回按天分桶的全量，范围筛选全在页面做：数据桥的路径白名单不含 `?`，
  // 而放宽那道校验只为一个统计接口并不值得（见 web/src/custombridgegate.ts）
  ctx.registerApi("stats", () => readStats())
}
