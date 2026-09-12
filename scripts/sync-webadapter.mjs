/**
 * 把 `dist/msgstats.js` 转成经典脚本放进 `webadapter/`，供统计页面在浏览器里直接用
 *
 * 为什么要拷而不是让页面自己写一份聚合：区间筛选只能在浏览器里算（数据桥的路径白名单不含
 * `?`，参数过不去），而 `aggregate()` / `shiftDay()` 这些「算错了也照样跑」的函数已被
 * src/msgstats.test.ts 的用例钉住。页面里另写一份的话，被测的就不是真跑的那一份 ——
 * 两份实现迟早分叉，而分叉的表现是图表数字不对，不是报错。
 *
 * **为什么要转成经典脚本，不能直接当 ES 模块用**：`<script type="module">` 的抓取一律走
 * CORS 模式，而统计页面跑在 sandbox 且**不带 allow-same-origin** 的 iframe 里（见
 * web/src/views/CustomPageView.vue），其源是不透明的 —— 请求带的是 `Origin: null`，
 * 而内核的静态挂载不回 `Access-Control-Allow-Origin`。于是模块脚本被静默拦下：
 * **一行都不执行，也没有任何错误提示**，页面只是永远停在「读取中…」。
 * 经典脚本走的是 no-cors 模式，不需要那个响应头。
 *
 * 与「让内核给静态资源加 CORS 头」相比，这条路不动内核：live 实例用的是 npm 上的 core，
 * 改框架在那边不生效；且给静态资源开 CORS 是全局影响，为一个页面开不划算。
 *
 * 为什么转得动：`msgstats.ts` 不 import 任何东西（当初为可测性所做的决定），故产物里
 * 只有顶层 `export`，剥掉再挂到一个全局名下即可，无须打包器。
 *
 * 为什么不让 webadapter 直接引 `../dist/`：静态挂载只挂 `webadapter/` 这一个目录
 * （见 src/custompage.ts 的 `ctx.static`），上级目录浏览器取不到。
 */
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"

/** 页面取用聚合函数的全局名，与 webadapter/stats.page.js 里的一致 */
const GLOBAL_NAME = "YZNG_MSGSTATS"

const root = join(import.meta.dirname, "..")
const from = join(root, "dist", "msgstats.js")
const to = join(root, "webadapter", "msgstats.js")

/**
 * 找出产物里所有顶层导出的名字
 *
 * 按名字收集而不是写死一张清单：msgstats.ts 日后多一个导出时，这里自动带上，
 * 而写死的清单会漏掉它 —— 漏掉的表现是页面上一个 `undefined is not a function`。
 * @param {string} code 产物源码
 * @returns {string[]} 导出的符号名
 */
function exportedNames(code) {
  const names = []
  const pattern = /^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of code.matchAll(pattern)) names.push(match[1])
  return names
}

try {
  const source = await readFile(from, "utf8")
  const names = exportedNames(source)
  if (names.length === 0) throw new Error("产物里没找到任何顶层导出，转换规则可能已失效")

  // 剥掉 `export `，把整份代码裹进 IIFE，再把符号挂到一个全局名下。
  // 裹进 IIFE 是为了不把这些名字直接撒到 window 上 —— 页面里若有同名变量会互相覆盖。
  const body = source
    .replace(/^export\s+/gm, "")
    // sourcemap 指向的行号在剥掉 export 之后已经对不上，留着只会误导
    .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
    .trimEnd()

  const out = [
    "/*",
    " * 本文件由 scripts/sync-webadapter.mjs 于构建时从 dist/msgstats.js 生成，请勿手改。",
    " * 改动请落在 src/msgstats.ts —— 那份有用例钉着（src/msgstats.test.ts）。",
    " */",
    ";(function () {",
    '  "use strict"',
    body,
    `  window.${GLOBAL_NAME} = { ${names.join(", ")} }`,
    "})()",
    ""
  ].join("\n")

  await mkdir(dirname(to), { recursive: true })
  await writeFile(to, out, "utf8")
  console.log(`[webadapter] 已生成 msgstats.js（经典脚本，导出 ${names.length} 项：${names.join(", ")}）`)
} catch (err) {
  // 构建顺序错了（先跑本脚本再 tsc）时说清是哪一步缺了，而不是丢一个 ENOENT 路径
  console.error(`[webadapter] 生成 msgstats.js 失败，请先执行 tsc -b：${err.message}`)
  process.exit(1)
}
