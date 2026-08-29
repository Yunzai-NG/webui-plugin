/**
 * 模块职责：把概览页的内置组件登记进注册表
 * 依赖方向：依赖 registry 与各组件；由 main.ts 在挂载前 import 一次
 * 生命周期：模块加载时执行注册，此后不再变动
 * 注意事项：**登记与页面分开。** 概览页只说「这里有一块组件板」，板上有什么由本文件决定 ——
 *          面板插件往概览页塞组件走的也是同一个 `registerWidget`，页面代码不必改一行。
 *
 *          **默认尺寸使六个计数块恰好排满一行（6 × 2 = 12 列）**，运行时表占满次行。计数块的
 *          下限取 2 列：1 列约 90px，装不下「已处理事件（排队 12）」那行小字。
 *
 *          **注册顺序即默认版面顺序**，故新增的项插在计数块与运行时表之间 —— 追加到末尾会让
 *          升级一次面板在使用者眼里成了「卡片自己重排了」。
 *
 *          **每一格都声明 `resizable`。** 不声明即固定尺寸，漏掉哪一枚那一枚就不能调。
 *
 *          **CPU 环与显卡环已撤，改由 hardware 提供**（双色环，同环两段分出整机与本进程）：
 *          两者都叫「CPU」时没有任何文案能说清哪个是哪个。不装 hardware 时就没有这两枚。
 *          内存环与磁盘条留着 —— 内存环量的是 `rss ÷ 全机内存`，与 hardware 的「整机已用 ÷
 *          整机总量」是两个不同的比值，不构成重名。
 */
import { registerWidget } from "../registry.js"
import DiskWidget from "./DiskWidget.vue"
import GaugeWidget from "./GaugeWidget.vue"
import RuntimeWidget from "./RuntimeWidget.vue"
import StatWidget from "./StatWidget.vue"
import { GAUGES } from "./gauges.js"
import { STATS } from "./stats.js"

for (const stat of STATS) {
  registerWidget({
    id: stat.id,
    page: "overview",
    title: stat.title,
    source: "builtin",
    layout: { w: 2, h: 1, minW: 2, minH: 1, resizable: true },
    component: StatWidget,
    props: { stat: stat.id }
  })
}

/*
 * 环与磁盘一律 h=3，下限同为 3
 *
 * 行高 80px、间隙 16px，故 h 只能取 80 / 176 / 272 / 368 这几档。这三格的内容实测
 * 190–199px，h=2（176px）装不下会长出滚动条，h=3 的 272px 余出的部分靠居中吃掉
 * （见 styles.css 的 `.gauge-card` / `.bars-wrap`）。
 *
 * `minH` 同为 3 而非 2：缩回 176px 就回到那条滚动条，且居中在溢出时失效
 * （`margin: auto` 算作 0），表现为「默认好看，拖过一次就坏」。
 */
const TALL = { w: 3, h: 3, minW: 2, minH: 3, resizable: true } as const

// 环的下限取 2 列：环本身可以缩，环下方的「CPU 占用」四个字缩到 1 列（约 90px）会折行
for (const gauge of GAUGES) {
  registerWidget({
    id: gauge.id,
    page: "overview",
    title: gauge.title,
    source: "builtin",
    layout: { ...TALL },
    component: GaugeWidget,
    props: { gauge: gauge.id }
  })
}

// 磁盘取 6 列：一条进度上要放「C:\」与「62% · 剩 8.4 GB / 200.1 GB」两端文字，
// 3 列（约 340px）时后者会与挂载点挤在一处
registerWidget({
  id: "overview.disk",
  page: "overview",
  title: "磁盘",
  source: "builtin",
  layout: { ...TALL, w: 6, minW: 3 },
  component: DiskWidget
})

/*
 * 显卡那一格已撤掉，由 hardware 面板插件包提供（`hardware.gpu`，标题同为「显卡」）
 *
 * 那枚认得出集显型号（`si.graphics()`，内置那枚只列 nvidia-smi 认得的卡），且排掉了被
 * 误列为显卡的虚拟显示器。不装 hardware 时概览页就没有显卡格 —— 内置那枚本就
 * `defaultHidden`，多数机器上从不出现在板上。
 *
 * `GpuWidget.vue` 连同 `SystemInfo.gpus` 一并留着未删：`/api/system` 是内核的公开接口，
 * 而那个组件是它唯一的示例用法。
 */

/*
 * 运行时表 h=3
 *
 * 20px 内边距下这张五行表是 277px，比 h=3 的 272px 多五像素。板内卡片的内边距因此
 * 降到 16px（见 styles.css 中 `.board .card`），表变成 269px，恰好落进 h=3。
 *
 * **下限同为 3**：缩到 176px 是五行表少掉近两行，而表格没有「缩小一点」的样子 ——
 * 行高由字号定，缩格只会把后几行推到滚动条以下。
 */
registerWidget({
  id: "overview.runtime",
  page: "overview",
  title: "运行时",
  source: "builtin",
  layout: { w: 12, h: 3, minW: 4, minH: 3, resizable: true },
  component: RuntimeWidget
})
