/**
 * 模块职责：把一次安装或更新的结果说成一句话
 * 依赖方向：只依赖 types 的类型声明，纯函数
 * 生命周期：无状态
 * 注意事项：抽出组件之外是为了能立断言。内核有三种结果（就地拉到新提交、已是最新、
 *          整目录重装），说错任一种都会把使用者引向错动作：**「已是最新」说成「已更新」**，
 *          他会转头去找那个并不存在的变化；**「整目录重装」说成「已更新」**，他不会想到
 *          目录里那份 `node_modules` 已随旧目录一起没了。
 *
 *          **依赖提示一律附上，不只在重装那条路上** —— 就地拉取同样可能拉来一份新增了
 *          依赖的 `package.json`。由内核的 `needsDependencies` 判定，此处不自行推断。
 */
import type { MarketInstallResult } from "./types.js"

/**
 * 把一次安装或更新的结果说成一句话
 * @param result 接口返回
 * @returns 提示文案
 */
export function resultText(result: MarketInstallResult): string {
  const dep = result.needsDependencies
    ? `该插件声明了运行时依赖，请在 ${result.dir} 目录执行 pnpm install 后重载。`
    : ""
  if (result.via === "pull") {
    if (result.changed === false) return `${result.name} 已是最新版本 ${result.version}，远端没有新提交。${dep}`
    const step =
      result.fromVersion === undefined || result.fromVersion === result.version
        ? result.version
        : `${result.fromVersion} → ${result.version}`
    return `${result.name} 已就地更新：${step}。目录内已装好的依赖未被动过。${dep}`
  }
  return dep === "" ? `${result.name} ${result.version} 已安装并加载。` : `${result.name} ${result.version} 已安装。${dep}`
}
