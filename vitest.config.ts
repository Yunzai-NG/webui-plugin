import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { defineConfig } from "vitest/config"

/**
 * 定位框架包的**源码**目录
 *
 * 测试一律解析到框架源码而不是 dist，理由与框架仓库内相同：走 dist 就必须先 build
 * 才能跑测试，忘了就测的是上一版；且 dist 内的相对导入带 `.js` 后缀，会被下方
 * 那条后缀改写规则命中而找不到文件。
 *
 * 三处候选依次尝试：`YZNG_FRAMEWORK` 环境变量、已安装或已链接包内的 `src`、
 * 与插件仓库同祖的框架 checkout。框架包的 `files` 含 `src`，故发布版亦带源码，
 * 第三方插件作者无须 checkout 框架即可跑测试。
 * @param pkg 包名
 * @returns 该包 src 目录的绝对路径；三处均不存在时 undefined
 */
function frameworkSrc(pkg: string): string | undefined {
  const short = pkg.slice("@yunzai-ng/".length)
  const roots: string[] = []
  if (process.env.YZNG_FRAMEWORK) roots.push(resolve(process.env.YZNG_FRAMEWORK, "packages", short))
  try {
    roots.push(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)))
  } catch {
    // 未安装亦未链接，交由其余候选处理
  }
  roots.push(resolve(import.meta.dirname, "..", "..", "code", "packages", short))
  for (const root of roots) {
    if (existsSync(resolve(root, "src", "index.ts"))) return resolve(root, "src")
  }
  return undefined
}

const core = frameworkSrc("@yunzai-ng/core")
const types = frameworkSrc("@yunzai-ng/types")

if (core === undefined || types === undefined) {
  throw new Error(
    "未找到框架源码。请设置 YZNG_FRAMEWORK 指向 yunzai-ng 的 checkout 根目录，" +
      "或先执行 pnpm run link:framework。"
  )
}

export default defineConfig({
  resolve: {
    alias: [
      // 具体子路径要排在裸包名之前，否则 `@yunzai-ng/core` 会先把它匹配掉
      { find: /^@yunzai-ng\/core\/testing$/, replacement: resolve(core, "testing/index.ts") },
      { find: /^@yunzai-ng\/core$/, replacement: resolve(core, "index.ts") },
      { find: /^@yunzai-ng\/types$/, replacement: resolve(types, "index.ts") },
      // 源码里 import 统一带 `.js` 后缀（NodeNext ESM 的硬要求），
      // 但测试时实际文件是 `.ts`，需要把相对导入的后缀改回来
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1.ts" }
    ]
  },
  test: {
    // 两处都收：`src` 是插件的 Node 侧入口，`web/src` 是面板里那些「凭字符串算版面」
    // 一类的纯函数 —— 它们算错不会报错，只会表现为版面不对，非有用例钉住不可。
    // 组件本身不进用例：那需要 jsdom 与 @vue/test-utils 两份依赖，而组件的验收
    // 走的是 temp/ 下针对真实实例的浏览器脚本，比在 jsdom 里模拟更接近实情。
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
    /*
     * 钉住时区，否则消息统计那组用例的结论取决于跑它的机器在哪儿
     *
     * `msgstats.ts` 整个模块都在算**本地**日期键与小时桶（`dayKey` 刻意不用
     * `toISOString()`，见那里的注释），而用例用 `new Date(2026, 8, 11, 1, 30)`
     * 一类的本地构造器造时刻。于是「本地切出来的键与 UTC 不同」这条断言在东八区
     * 的开发机上成立、在 UTC 的 CI runner 上必然失败 —— 本仓库的 CI 就这样红过一次，
     * 而报错（`expected '2026-09-11' not to be '2026-09-11'`）看不出与时区有关。
     *
     * 取 `Asia/Shanghai` 而非随便一个非 UTC 时区：本插件的使用者绝大多数在这个时区，
     * 让用例跑在与实际部署相同的偏移上，边界（凌晨那几个小时）才是真实的那一个。
     * **不选带夏令时的时区** —— 那会让「某一天有 23 或 25 个小时」渗进小时桶的用例，
     * 而那是另一件事，不该夹在这里顺带测。
     */
    env: { TZ: "Asia/Shanghai" },
    // 内核用到 level/sqlite 等原生模块，串行更稳
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"]
    }
  }
})
