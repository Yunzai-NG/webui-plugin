/**
 * 模块职责：卡片标题怎么写 —— 名字去掉括号里的补充说明
 * 依赖方向：不依赖任何东西，纯函数
 * 生命周期：无状态
 * 注意事项：不并进 format.ts：那边引着 api.ts，模块加载即读 localStorage，单测里跑不起来
 */

/**
 * 卡片标题：去掉括号与其中的内容
 *
 * 「OneBot v11 适配器（NapCat / LLOneBot / SnowLuma）」在窄卡上折成三行，括号里那串是补充，
 * 全名留在悬停与「查看」里。中英文括号都认；去完是空串时（整个名字都在括号里）原样返回。
 * @param name 名字
 * @returns 卡片上显示的名字
 */
export function cardTitle(name: string): string {
  const short = name.replace(/\s*[（(][^（）()]*[）)]/g, "").trim()
  return short === "" ? name : short
}
