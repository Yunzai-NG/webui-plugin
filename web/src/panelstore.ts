/**
 * 模块职责：面板插件商店的取数地址、装后步骤的说法与「一次安装的结果该怎么说」
 * 依赖方向：只依赖本目录的类型声明，纯函数
 * 生命周期：无状态
 * 注意事项：页签与筛选**不在此处**，在 `filter.ts` —— 两个市场页签语义相同（全部 / 已安装 /
 *          可更新），各写一份迟早分叉。留在这里的都是面板插件包独有的说法。
 *
 *          抽出组件之外是为了能立断言 —— 用例只覆盖 `.ts`，`.vue` 里的逻辑无 jsdom 测不到。
 *          三处说错就会把使用者引向错动作：
 *
 *          1) **「装完之后该做什么」有三种答案，取决于包的形态。** 只有浏览器侧的包刷新
 *             页面即生效；带 node 侧的包要**重载 webui**（node 侧入口只在 webui 的
 *             `setup()` 里 import 一次）；还缺依赖的包要先装依赖再重载。说成一句「已安装」，
 *             使用者会刷新页面、看不到东西、以为装坏了。
 *          2) **「已是最新」不能说成「已更新」**（同内核那条，见 `market.ts`）：后者会让人
 *             转头去找那个并不存在的变化。
 *          3) **就地拉取与整目录重装的后果不同**：前者保住了 `node_modules`，后者那份依赖
 *             已随旧目录一起没了。
 */
import type { PanelStoreItem, PanelStoreResult } from "./types.js"

/** 商店端点，落在 webui 自己的 scope 下而非 `/api` 之内 */
const STORE_SCOPE = "/plugin/webui/panelstore"

/**
 * 商店的取数地址
 * @param path 子路径，省略即列表端点
 * @returns 绝对地址
 */
export function storeUrlOf(path = ""): string {
  return path === "" ? STORE_SCOPE : `${STORE_SCOPE}/${path}`
}

/**
 * 这一条装 / 更时要不要跑包管理器
 *
 * **两种情形都要跑**：声明了依赖的包要装依赖；声明了装后步骤的包要跑那几个 script ——
 * 后者即便不声明依赖也得跑，因为产物那一层（`dist/`）多半被包仓库 `.gitignore` 掉了。
 *
 * 抽成函数是因为装与更两条路都要这个判据，而它们各有一个确认框。分两处写迟早对不上，
 * 症状是「安装时编译了，更新时没编译」—— 那种不一致要等到某个组件行为像旧版才发现。
 * @param item 条目
 * @returns 是否要跑
 */
export function willRunPm(item: PanelStoreItem): boolean {
  return item.deps === true || (item.setup?.scripts.length ?? 0) > 0
}

/**
 * 「装完之后还会自动做什么」那几句，装与更的确认框共用
 *
 * 逐条写出会跑什么，而不是一句「会自动装依赖」：`build` 要编译、装后步骤可能下载上百兆，
 * 事先不说会让人以为界面卡住了。那也是知情同意的「知情」那一半 —— 但它不是一道新的信任
 * 边界，包的 node 侧入口稍后同样会被 `import()` 执行。
 * @param item 条目
 * @returns 说明行；这一条什么都不跑时为空数组
 */
export function setupNotes(item: PanelStoreItem): string[] {
  if (!willRunPm(item)) return []
  const notes = ["装完会在包目录内执行 pnpm install（找不到 pnpm 时退回 npm），那一步会执行该包依赖的 install 脚本"]
  const scripts = item.setup?.scripts ?? []
  if (scripts.length > 0) {
    notes.push(
      `随后按索引声明依次执行 ${scripts.join("、")} —— 其中可能包含编译，耗时可达数分钟`,
      "**这一步不能省**：这个包的产物目录多半没进仓库，不编译就只有源码，node 侧的接口会一律 404"
    )
  }
  notes.push("这不是一道新的信任边界：包的 node 侧入口稍后同样会被 import() 执行，与 install 脚本同属一道门")
  return notes
}

/**
 * 版本一行怎么写
 *
 * 已装且索引更高时给「0.3.0 → 0.4.0」；已装且一致时只给一个数；未装时给索引里那个。
 * @param item 条目
 * @returns 版本文案
 */
export function versionText(item: PanelStoreItem): string {
  const indexed = item.version ?? "未声明"
  if (!item.installed) return indexed
  const local = item.installedVersion ?? "未知"
  return item.updatable ? `${local} → ${indexed}` : local
}

/**
 * 把一次安装或更新的结果说成一句话
 *
 * 三段拼起来：**这次做了什么**、**依赖怎么样**、**下一步该做什么**。第三段是本函数存在的
 * 主要理由 —— 见文件头第 1 条。
 * @param result 接口返回
 * @returns 提示文案
 */
export function storeResultText(result: PanelStoreResult): string {
  const did = didText(result)
  const dep = depText(result)
  const next = nextText(result)
  return [did, dep, next].filter(part => part !== "").join(" ")
}

/**
 * 第一段：这次到底做了什么
 * @param result 接口返回
 * @returns 文案
 */
function didText(result: PanelStoreResult): string {
  if (result.via === "pull") {
    if (result.changed === false) return `${result.name} 已是最新版本 ${result.version}，远端没有新提交。`
    const step =
      result.fromVersion === undefined || result.fromVersion === result.version
        ? result.version
        : `${result.fromVersion} → ${result.version}`
    return `${result.name} 已就地更新：${step}。目录内已装好的依赖未被动过。`
  }
  // 归档来源要顺带说一句「此后更新要整目录重下、依赖跟着重装」：
  // 那笔代价在装完的这一刻是隐形的，等第一次更新等了十分钟才发现就太晚了。git 来源是常态，不出声
  const cost = result.updatable === "reinstall" ? "此后的更新会整目录重下（该来源没有 git 仓库可供就地拉取）。" : ""
  return `${result.name} ${result.version} 已装到 ${result.dir}。${cost}`
}

/**
 * 第二段：依赖的状况
 *
 * 三种：跑过且成了、跑过但失败了、没跑而确实缺。**「没声明依赖」不出声** —— 那是多数
 * 面板插件的常态，为此多一句话只会淹掉真正要读的第三段。
 * @param result 接口返回
 * @returns 文案；无须出声时空串
 */
function depText(result: PanelStoreResult): string {
  const pm = result.packageManager ?? "包管理器"
  if (result.dependencyError !== undefined) {
    return `但依赖没装上（${result.dependencyError}），请在该目录内自行执行 pnpm install。`
  }
  /*
   * 装后步骤失败要排在「依赖装好了」之前说
   *
   * 那一步失败多半意味着没有产物（`build` 挂了），而带 node 侧的包的入口正指向 `dist/`——
   * 此时只说「依赖已装好」是对的却没用，使用者会去重载、再收到一条「找不到模块」。
   */
  if (result.setupError !== undefined) {
    return `依赖已由 ${pm} 装好，但装后步骤失败（${result.setupError}），请在该目录内自行处理。`
  }
  if (result.installedDeps === true) {
    const ran = result.ranScripts ?? []
    return ran.length === 0 ? `依赖已由 ${pm} 装好。` : `依赖已由 ${pm} 装好，并执行了 ${ran.join("、")}。`
  }
  if (result.needsDependencies) return `该包声明了运行时依赖，请在该目录内执行 pnpm install。`
  return ""
}

/**
 * 第三段：下一步该做什么
 *
 * 三种答案里最容易说错的一段。只有浏览器侧的包刷新页面即生效；带 node 侧的包要重载 webui；
 * 还缺依赖的包重载也没用 —— 它的 node 侧入口会 import 失败。
 * @param result 接口返回
 * @returns 文案
 */
function nextText(result: PanelStoreResult): string {
  if (result.via === "pull" && result.changed === false) return ""
  /*
   * 装后步骤失败要排在「只有浏览器侧」之前判
   *
   * 那一步失败意味着没有产物，而**产物对两种形态都要紧**：带 node 侧的包，入口就指向
   * `dist/`；只有浏览器侧的包，它的组件文件本身也可能是编译出来的。此时说「刷新页面即可
   * 看到它的组件」是假的 —— 使用者会刷新、看不到东西、以为装坏了，而真正的原因刚在
   * 上一段说过。放在 `!hasServer` 之后判就漏掉了后一种，这一条曾经如此。
   */
  if (result.setupError !== undefined) return "编译通过后再重载 —— 现在缺产物，装上了也跑不起来。"
  if (!result.hasServer) return "刷新页面即可看到它的组件。"
  if (result.needsDependencies) return "装完依赖后，到插件页重载 webui，它的 node 侧才会跑起来。"
  return "这个包带 node 侧，须到插件页重载 webui 才会生效 —— 只刷新页面不够。"
}
