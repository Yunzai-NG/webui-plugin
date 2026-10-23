# @yunzai-ng/webui-plugin

[Yunzai NG](https://github.com/Yunzai-NG) 的面板：概览、账号、日志、数据库、插件、扩展页面、插件市场、
面板商店、配置、帮助与外观。配置表单并非手写，而是由各插件声明的 schema 生成；外观可换整套主题。

**内核不自带面板。** 内核只检测站点根路径是否已被接管，因此「面板由谁提供」只有一个
答案：某个调用了 `ctx.panel()` 的插件。未安装本插件时，内核照常启动，仅 `/api` 可用。

## 安装

推荐在面板的**插件市场**里安装与更新，无须命令行。首次安装面板本身则用下面两种方式之一。

### 从插件市场（已有面板时）

面板 → 插件市场 → 找到 webui → 更新。装完重启内核。

装依赖与构建由内核代跑：索引里本包声明了 `setup.scripts: ["build"]`，故市场会在包目录内
依次执行 `pnpm install` 与 `pnpm run build`。这一步不能省 —— 本仓库不发布至 npm，git 里
也不含构建产物，没有那次 `build` 就没有 `dist/index.js`。下面「从源码」那两步手工做的正是
同一件事。

### 从源码

本仓库不发布至 npm，git 里也不含构建产物，因此**两步都不能省**：

```bash
cd <home>/plugins
git clone https://github.com/Yunzai-NG/webui-plugin.git webui
cd webui
pnpm install
pnpm run build
```

`<home>` 是内核的主目录，即 `yzng init` 所在的那个目录。

- 少了 `pnpm install`：没有 TypeScript 与 Vite，下一步跑不起来。
- 少了 `pnpm run build`：`dist/index.js` 不存在，内核找不到入口，插件被跳过并记一条警告，
  面板不会加载。`build` 同时产出插件入口与前端两套产物，缺后者会得到一个能加载但整站 404
  的插件。

装完重启内核。构建之后 `node_modules/` 可以删掉省下磁盘 —— 运行期只需要内核提供的
`@yunzai-ng/core` 与 `@yunzai-ng/types`，其余全是构建期依赖。

> 在主目录之外克隆（开发场景）时，`tsc -b` 会因找不到 `@yunzai-ng/core` 而失败，此时
> 先跑一次 `pnpm run link:framework`。装在 `<home>/plugins/` 之下不需要这一步：内核的
> `init` / `start` 已把框架包链至 `<home>/node_modules/`，Node 与 tsc 都能自插件目录
> 逐级向上找到它。

## 用面板

访问内核日志里给出的地址（默认 `http://127.0.0.1:2536`），用同一行日志里的令牌登录。

| 页面 | 做什么 |
|---|---|
| 概览 | 运行状态、资源占用；卡片可拖动改版面 |
| 账号 | 按适配器分页签；在弹窗里添加与登录机器人账号 |
| 日志 | 实时日志，可按级别筛选 |
| 插件 | 已装插件的启停、配置与详情 |
| 插件市场 | 装 / 更 / 删内核插件 |
| 面板商店 | 装 / 更 / 删面板组件 |
| 配置 | 编辑内核配置 |
| 帮助 | 命令一览与文档入口 |
| 外观 | 主题、明暗、版式、动效与备份 |

概览页的卡片进入编辑态后可拖动、缩放与移除，版面存在浏览器本地。

**主题**在「外观」页换：内置「经典」（默认）与「YUNZAI NG」，更多的在面板商店的「主题」栏。主题换的是
一整身皮肤 —— 配色、图标、边框、开关贴图与插图，面板插件的组件与扩展页面也跟着换。明暗（跟随系统 /
浅色 / 深色）与主题是两回事，单独切换。经典默认是云蓝与云青、蓝白与靛蓝底；YUNZAI NG 按新品牌图标的南瓜黄橙红、云与光环青蓝紫配色，控件与插图一同换色。主题把页面弄坏时在地址后加 `?theme=safe` 打开。

**只读模式**（内核配置 `server.readonly`）下全部写操作被拒绝，面板会隐去相应按钮。

## 给面板加组件

面板可由**手写的 `.js`** 添加组件，无须构建、无须重启内核。只有一处落点：本插件安装目录
下的 `plugins/`（即 `<home>/plugins/webui/plugins/`）。放进去刷新页面即生效。

推荐用面板商店安装现成的，例子见官方的
[hardware-plugin](https://github.com/Yunzai-NG/hardware-plugin)。

> **注意**：`plugins/` 在本插件安装目录之下，而更新走整目录替换 —— **「更新 webui」会
> 清空它。** 请自己留一份备份。

自己写一个见下方的开发文档。

## 文档

- [面板说明](https://yunzai-ng.github.io/plugins/webui) —— 这是什么、装在哪、各页面做什么
- [外观与主题](https://yunzai-ng.github.io/themes) —— 换主题、明暗、个人偏好、安全模式
- [面板插件开发](https://yunzai-ng.github.io/panel-plugin) —— 写法、`api` 的全部成员、node 侧入口与配置项
- [主题开发](https://yunzai-ng.github.io/theme-dev) —— 清单、令牌、`data-part` 钩子、槽位与上架
- [设计令牌](https://yunzai-ng.github.io/design-tokens) —— 面板、插件、扩展页与主题共用的 CSS 变量全表

## 开发

```bash
pnpm install
pnpm run link:framework   # 在主目录之外开发时需要
pnpm run dev:web          # 前端开发服务器，/api 代理至 127.0.0.1:2536
pnpm run verify           # build → typecheck:test → typecheck:web → lint → test
```

`dev:web` 代理真实的 WebSocket 而非 mock 数据：日志页依赖推送，mock 看不出
「断开后订阅是否摘净」这类问题。

前端不引 UI 框架 —— 引入组件库的代价是约 300KB 产物与一套额外 API，而面板要能在
Termux 的手机浏览器里打开。

## 许可

以 AGPL-3.0-or-later 许可发布，与框架仓库一致。
