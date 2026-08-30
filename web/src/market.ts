/**
 * 模块职责：把一次安装、更新或收尾的结果说成一句话
 * 依赖方向：只依赖 types 的类型声明，纯函数
 * 生命周期：无状态
 * 注意事项：抽出组件之外是为了能立断言。内核有三种取源结果（就地拉到新提交、已是最新、
 *          整目录重装），说错任一种都会把使用者引向错动作：**「已是最新」说成「已更新」**，
 *          他会转头去找那个并不存在的变化；**「整目录重装」说成「已更新」**，他不会想到
 *          目录里那份 `node_modules` 已随旧目录一起没了。
 *
 *          **「还缺依赖」与「刚装过依赖」是两件事，各有各的句子。** 内核现在会代跑包管理器，
 *          于是 `needsDependencies` 为假的原因有两种：本来就不缺，或刚才装好了。后者要说出来，
 *          否则一次几分钟的等待在界面上没有任何交代。
 *
 *          **两种失败分开说，因为后手不同**：依赖装不上是去目录里执行包管理器；装后步骤
 *          （`build` 之类）失败是去执行那个 script。合成一句只能给出两头都不准的提示，而
 *          缺产物的插件加载时报的是「找不到模块」，与真实原因隔着一层。
 */
import type { MarketInstallResult, MarketSetupResult, SetupOutcome } from "./types.js"

/**
 * 把收尾那几项说成一句话
 *
 * 顺序即重要性：两种失败在前，因为那是唯一需要使用者动手的情形。
 * @param result 收尾那几项
 * @param dir 插件目录，用于告诉使用者去哪里执行命令
 * @returns 提示文案；无话可说时空串
 */
function setupText(result: SetupOutcome, dir: string): string {
  const pm = result.packageManager ?? "pnpm"
  if (result.dependencyError !== undefined) {
    return `依赖安装失败：${result.dependencyError}。请在 ${dir} 目录执行 ${pm} install 后重载。`
  }
  if (result.setupError !== undefined) {
    // setupError 已带「<script>：」前缀，故此处不再重复 script 名
    return `装后步骤失败：${result.setupError}。请在 ${dir} 目录内自行处理后重载。`
  }
  if (result.needsDependencies) {
    return `该插件声明了运行时依赖，请在 ${dir} 目录执行 ${pm} install 后重载。`
  }
  if (result.installedDeps !== true) return ""
  const ran = result.ranScripts ?? []
  return ran.length === 0 ? `依赖已由 ${pm} 装好。` : `依赖已由 ${pm} 装好，并执行了 ${ran.join("、")}。`
}

/**
 * 把一次安装或更新的结果说成一句话
 * @param result 接口返回
 * @returns 提示文案
 */
export function resultText(result: MarketInstallResult): string {
  const tail = setupText(result, result.dir)
  if (result.via === "pull") {
    if (result.changed === false) return `${result.name} 已是最新版本 ${result.version}，远端没有新提交。${tail}`
    const step =
      result.fromVersion === undefined || result.fromVersion === result.version
        ? result.version
        : `${result.fromVersion} → ${result.version}`
    return `${result.name} 已就地更新：${step}。目录内已装好的依赖未被动过。${tail}`
  }
  /*
   * 「已加载」这半句只在确实加载了的时候说
   *
   * 缺依赖、依赖装失败、装后步骤失败三种情形内核都不加载（见 api.ts 的 installFromMarket），
   * 此时说「已加载」是假的，而使用者会据此以为可以直接去用了。
   */
  const loaded = result.loaded.includes(result.name)
  return loaded
    ? `${result.name} ${result.version} 已安装并加载。${tail}`
    : `${result.name} ${result.version} 已安装。${tail}`
}

/**
 * 把一次单独发起的收尾说成一句话
 *
 * 与安装那条路共用 {@link setupText}，故「装成了」「装失败了」的说法只有一处定义。
 * @param result 接口返回
 * @returns 提示文案
 */
export function setupResultText(result: MarketSetupResult): string {
  const tail = setupText(result, result.dir)
  // 空串意味着既没装、也不缺 —— 那是「没有声明依赖」，须说出来，否则点了按钮像是什么都没发生
  const done = tail === "" ? "该插件没有声明依赖，无须安装。" : tail
  return result.loaded.includes(result.name) ? `${result.name}：${done}已重新加载。` : `${result.name}：${done}`
}
