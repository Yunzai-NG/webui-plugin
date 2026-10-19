/**
 * 模块职责：面板插件包的「更新」—— 确认框与请求，面板商店页与插件页共用
 * 依赖方向：依赖 api / confirm / panelstore / types
 * 生命周期：无状态
 * 注意事项：两页各写一份的话，迟早一边改了确认文案或 `dependencies` 的判据而另一边没改，
 *          症状是「在商店更新编译了、在插件页更新没编译」，产物停在旧版本且毫无迹象。
 */
import { postAt } from "./api.js"
import { askConfirm } from "./confirm.js"
import { setupNotes, storeResultText, storeUrlOf, versionText, willRunPm } from "./panelstore.js"
import type { PanelStoreItem, PanelStoreResult } from "./types.js"

/**
 * 问一次要不要更新
 * @param item 商店条目
 * @returns 是否继续
 */
export function askPanelUpdate(item: PanelStoreItem): Promise<boolean> {
  return askConfirm({
    title: `更新面板插件「${item.title}」？`,
    body: "更新方式由 webui 判定：包目录是 git 仓库且索引声明 git 来源时就地拉取，否则整目录重下。",
    okText: "更新",
    details: [
      `当前：${versionText(item)}`,
      "就地拉取：目录重置到远端最新提交，已装的依赖保留；本地改动自动暂存，可用 git stash pop 取回",
      "退回重装：目录整份替换，含 node_modules —— 那份依赖要重装一遍",
      "两条路都不动这个包的配置 —— 它存在 webui 的数据目录下，不在包目录里",
      item.server === true ? "更新后重载 webui 并刷新页面，只刷新不足以加载新的 node 侧" : "更新后刷新页面生效",
      ...setupNotes(item)
    ]
  })
}

/**
 * 发更新请求
 * @param item 商店条目
 * @returns 给使用者的那句回执
 */
export async function postPanelUpdate(item: PanelStoreItem): Promise<string> {
  const result = await postAt<PanelStoreResult>(storeUrlOf(`${encodeURIComponent(item.name)}/update`), {
    dependencies: willRunPm(item)
  })
  return storeResultText(result)
}
