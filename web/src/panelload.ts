/**
 * 模块职责：面板插件的装载 —— 拉清单、`import()` 每个文件、校验形状、注册进注册表
 * 依赖方向：依赖 api 的 getAt、panelcheck 的校验、panelapi 的 makePanelApi、registry
 * 生命周期：`loadPanelPlugins` 由 main.ts 在挂载之前调用一次
 * 注意事项：**整段不抛错。** 清单取不到、某个文件 404、模块语法错、默认导出缺字段 ——
 *          任何一条抛到 main.ts 都会让整个面板打不开。故逐项 try，失败的那一项转成
 *          占位格（复用 `.card.wfail` 样式，见 `WidgetCell.vue`），`page` 取 `overview`。
 *
 *          **`import()` 的 URL 由 node 侧给出，不在这里拼。** 拼在两处就会漂移，
 *          表现为全部插件一齐 404。
 *
 *          **配置在 import 之前登记。** 组件的 `setup` 里就会读 `api.config`，
 *          登记晚一步它读到的是空对象 —— 只在首次渲染那一瞬间存在的错。
 */
import { defineComponent, h } from "vue"
import type { Component } from "vue"
import { getAt } from "./api.js"
import { makePanelApi, type PanelApiDeps, type PanelTab, type PanelWidget } from "./panelapi.js"
import {
  checkConfigPlace,
  checkPanelTabs,
  checkPanelWidgets,
  checkStylePlace,
  entryLabel,
  packageKeyOf,
  parseManifest,
  placeholderId,
  resolvePanelMeta,
  type PanelEntry
} from "./panelcheck.js"
import { notePanelConfigProblem, registerPanelConfig } from "./panelconfig.js"
import { loadPanelStyle } from "./panelstyle.js"
import { registerTab, registerWidget } from "./registry.js"
import { ROUTES } from "./router.js"

/** 清单端点，与 node 侧 `src/index.ts` 的 `PANELS_ENDPOINT` 对应 */
const MANIFEST_URL = "/plugin/webui/panels.json"

/** 占位格挂在哪一页；模块没解析成功时无从知道它想挂哪一页 */
const FALLBACK_PAGE = "overview"

/**
 * 造一个占位组件
 *
 * 用 `defineComponent` 而非裸渲染函数：函数式组件拿不到组件名，devtools 的组件树里
 * 一格「AnonymousComponent」在排查时毫无用处。
 * @param entry 清单项
 * @param reason 失败原因，直接示于格内
 * @returns vue 组件
 */
function placeholder(entry: PanelEntry, reason: string): Component {
  return defineComponent({
    name: "PanelPluginFailed",
    setup() {
      return () =>
        h("div", { class: "card wfail" }, [
          h("b", "此组件加载失败"),
          h("p", entryLabel(entry)),
          h("p", { class: "mono" }, reason)
        ])
    }
  })
}

/**
 * 把一个校验过的插件定义转成 vue 组件
 *
 * `setup` 由插件作者书写，故就地调用：它抛错时抛在 vue 的 setup 期间，由
 * `WidgetCell.vue` 的 `onErrorCaptured` 兜住，只废掉那一格。**不在这里 try** ——
 * 多一层只会让错误位置离出错的那行更远。
 * @param widget 插件定义
 * @param deps 本包的 node 侧基地址与包键，由清单算出
 * @returns vue 组件
 */
function toComponent(widget: PanelWidget, deps: PanelApiDeps): Component {
  return defineComponent({
    name: `PanelPlugin_${widget.id.replace(/[^A-Za-z0-9_]/g, "_")}`,
    setup() {
      return widget.setup(makePanelApi(deps))
    }
  })
}

/**
 * 把一个校验过的页签定义转成 vue 组件
 *
 * 与 `toComponent` 同一形状，只是名字前缀不同 —— devtools 的组件树里要分得出
 * 「这是一个页签」还是「这是一格组件」。
 * @param tab 页签定义
 * @param deps 本包的 node 侧基地址与包键
 * @returns vue 组件
 */
function tabComponent(tab: PanelTab, deps: PanelApiDeps): Component {
  return defineComponent({
    name: `PanelTab_${tab.id.replace(/[^A-Za-z0-9_]/g, "_")}`,
    setup() {
      return tab.setup(makePanelApi(deps))
    }
  })
}

/**
 * 注册一项
 * @param entry 清单项
 */
async function loadOne(entry: PanelEntry): Promise<void> {
  /**
   * 登记一格占位并作罢
   * @param what 括在标题里的失败类别
   * @param reason 示于格内的原因
   */
  const fail = (what: string, reason: string): void => {
    registerWidget({
      id: placeholderId(entry),
      page: FALLBACK_PAGE,
      title: `${entry.file}（${what}）`,
      source: "plugin",
      layout: { w: 3, h: 3, minW: 2, minH: 2 },
      component: placeholder(entry, reason),
      failure: reason,
      from: entryLabel(entry),
      /*
       * 失败的占位格同样带上包键
       *
       * 少了它，一个包里坏掉的那一枚会按 id 兜底自成一张卡片 —— 而「装了却没出现」的
       * 答案本该在它所属那个包的详情里。
       */
      pkg: packageKeyOf(entry),
      ...(entry.kind === undefined ? {} : { kind: entry.kind })
    })
  }

  /*
   * 配置先于一切登记
   *
   * 组件的 `setup` 里就会读 `api.config`，登记晚一步它读到的就是空对象 —— 只在首次
   * 渲染那一瞬间存在的错，此后一切正常，最难查。schema 与值都取自清单，浏览器侧一个字
   * 都不算，理由见 `panelconfig.ts` 文件头。
   */
  const pkg = packageKeyOf(entry)
  if (entry.config !== undefined) registerPanelConfig(pkg, entry.config.schema, entry.config.value)
  if (entry.configError !== undefined) {
    console.error(`面板插件 ${entryLabel(entry)} 的配置声明有问题：${entry.configError}`)
    notePanelConfigProblem(pkg, entry.configError)
  }

  if (entry.styleError !== undefined) {
    console.error(`面板插件 ${entryLabel(entry)} 的样式表声明有问题：${entry.styleError}`)
  }

  /*
   * 样式与模块同时开始取，最后一并等
   *
   * 两者互不相干，串起来就是两趟往返首尾相接 —— 而挂载前的等待有 3 秒上限（见 main.ts）。
   * 不能取完就撒手不等：那样页面可能先挂载，使用者看到的是这一格先无样式地闪一下。
   */
  const styling =
    entry.style === undefined ? undefined : loadPanelStyle(packageKeyOf(entry), entry.style)

  /** 注入给本包组件与页签的那两件事 */
  const deps: PanelApiDeps = { pkg, ...(entry.api === undefined ? {} : { apiBase: entry.api }) }

  let mod: unknown
  let failure: unknown
  try {
    mod = await import(/* @vite-ignore */ entry.url)
  } catch (err) {
    failure = err
  }

  // 样式在此一并等，且在分支之前 —— 装载失败的那一路也已经开始取它，不等就漏一个悬着的请求
  await styling

  if (failure !== undefined) {
    const reason = failure instanceof Error ? failure.message : String(failure)
    console.error(`面板插件 ${entryLabel(entry)} 加载失败`, failure)
    fail("加载失败", reason)
    return
  }

  /* 「schema 写错了地方」要有模块在手才判得出，故这一句在 import 之后 */
  const misplaced = checkConfigPlace(mod, entry)
  if (misplaced !== undefined) {
    console.error(`面板插件 ${entryLabel(entry)}：${misplaced}`)
    notePanelConfigProblem(pkg, misplaced)
  }

  /*
   * 「样式表写错了地方」同理，但只在控制台出声
   *
   * 不进包详情：那一栏是「配置未生效」，而这一条说的是样式。合进去要么改掉那栏的措辞
   * （于是它对两件事都说得含糊），要么再添一栏 —— 而这一条的读者是包的作者本人，
   * 他此刻正对着控制台。
   */
  const styleMisplaced = checkStylePlace(mod, entry)
  if (styleMisplaced !== undefined) console.error(`面板插件 ${entryLabel(entry)}：${styleMisplaced}`)

  /*
   * 元信息在形状之前校验：两者都不过时，先说的那句才是使用者看到的，而缺 meta 要补一段
   * 导出、形状不对要改一处拼写 —— 先报形状会把前者引向改拼写这条错路。
   */
  const meta = resolvePanelMeta(mod, entry)
  if (!meta.ok) {
    console.error(`面板插件 ${entryLabel(entry)} 缺少自报信息：${meta.reason}`)
    fail("缺少信息", meta.reason)
    return
  }

  const checked = checkPanelWidgets(
    mod,
    ROUTES.map(r => r.id)
  )
  if (!checked.ok) {
    console.error(`面板插件 ${entryLabel(entry)} 的形状不对：${checked.reason}`)
    fail("形状不对", checked.reason)
    return
  }

  /*
   * 部分组件不合格时只在控制台出声，不画占位格：那一格既不属于任何一页（占位格一律落在
   * 概览），也无从说清「十枚里的第几枚」。合格的那些照常上板。
   */
  for (const reason of checked.skipped) {
    console.error(`面板插件 ${entryLabel(entry)} 有一枚组件被跳过：${reason}`)
  }

  for (const widget of checked.widgets) {
    registerWidget({
      id: widget.id,
      page: widget.page,
      title: widget.title,
      source: "plugin",
      layout: {
        w: widget.defaultLayout.w,
        h: widget.defaultLayout.h,
        minW: widget.defaultLayout.minW ?? 1,
        minH: widget.defaultLayout.minH ?? 1,
        /*
         * `resizable` 原样透传，不替它猜：校验已保证「声明可调则必有下限」（见
         * `panelcheck.ts`）。替没声明的补一个 `true`，那两行 `?? 1` 就成了它的下限，
         * 即作者什么都没说、他的卡片却能被拖成 1×1。
         */
        ...(widget.defaultLayout.resizable === true ? { resizable: true } : {})
      },
      component: toComponent(widget, deps),
      meta: meta.meta,
      kind: entry.kind ?? "single",
      from: entryLabel(entry),
      pkg: packageKeyOf(entry),
      ...(widget.defaultHidden === true ? { defaultHidden: true } : {})
    })
  }

  /*
   * 页签在组件之后注册，且**一个都不合格也不影响这个包的组件**
   *
   * 不合格的只在控制台出声，不画占位格 —— 占位格是栅格里的一格，而页签占的是插件页的
   * 整块内容区，没有「那一格」可以安放它。
   */
  const tabs = checkPanelTabs(mod)
  for (const reason of tabs.skipped) {
    console.error(`面板插件 ${entryLabel(entry)} 有一个页签被跳过：${reason}`)
  }
  for (const tab of tabs.tabs) {
    registerTab({
      id: tab.id,
      title: tab.title,
      pkg: packageKeyOf(entry),
      component: tabComponent(tab, deps)
    })
  }
}

/**
 * 拉清单、装载全部面板插件
 *
 * **清单取不到时静默返回**：最常见的情形是 node 侧还没起来，那时画一格占位会出现在
 * 每一个没装任何面板插件的人的概览页上。
 *
 * 全部项**并发**装载：逐个 await 就是 n 趟往返串起来，而挂载前的等待有 3 秒上限
 * （见 main.ts）。
 * @returns 无
 */
export async function loadPanelPlugins(): Promise<void> {
  let manifest: unknown
  try {
    manifest = await getAt<unknown>(MANIFEST_URL)
  } catch (err) {
    console.error("面板插件清单取不到，本次不装载任何面板插件", err)
    return
  }

  const entries = parseManifest(manifest)
  await Promise.all(entries.map(loadOne))
}
