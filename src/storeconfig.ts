/**
 * 模块职责：webui 自己的配置 schema —— 面板插件商店的三项设置
 * 依赖方向：依赖 `@yunzai-ng/core` 导出的 schema 构造器；不认识商店的实现
 * 生命周期：模块级常量，随 `definePlugin` 的 `configSchema` 交给内核
 * 注意事项：只有商店那三项：索引地址、缓存生存期、请求超时。
 *
 *          镜像前缀与只读开关刻意不在这里，两者都读内核的配置（见 `coreconfig.ts`）：镜像在国内网络下
 *          是「能不能装上」的前提，填两遍必有人忘；只读是站点级策略，webui 再声明一个就有了两个可互相
 *          打架的事实。
 *
 *          三项默认值与内核 `market` 那一组刻意一致（缓存 1 小时、超时 15 秒）：两处做的是同一类事。
 */
import { s } from "@yunzai-ng/core"

/** 官方面板插件索引地址 */
export const DEFAULT_STORE_INDEX = "https://raw.githubusercontent.com/Yunzai-NG/plugin-index/main/webui_index.json"

/**
 * webui 的配置 schema
 *
 * 只有 `store` 一组。分组名与标题按内核配置页的形制填 —— 那一页按 `group` 分节，
 * 不填则落进一个没有标题的区块里。
 */
export const webuiConfigSchema = s.object({
  store: s
    .object({
      sources: s
        .array(s.string())
        .default([DEFAULT_STORE_INDEX])
        .title("索引地址")
        .desc(
          "面板插件商店的索引文件地址，可填多个。靠前的地址优先，同名包以先出现者为准，" +
            "因此私有索引应置于官方索引之前。索引文件为 JSON，形如 { panels: [...] } —— " +
            "顶层键是 panels，与内核插件市场那份（plugins）刻意不同，填错了会直接报格式不符。"
        ),
      cacheTtl: s
        .duration()
        .default("1h")
        .title("索引缓存有效期")
        .desc("有效期内不再请求索引。缓存同时落盘一份，故无网络时仍可列出上次取到的条目。"),
      timeout: s
        .duration()
        .default("15s")
        .title("索引请求超时")
        .desc("单个索引地址的请求超时。包的下载、克隆与依赖安装另有更长的超时。")
    })
    .title("面板插件商店")
    .group("面板插件商店")
    .order(10)
})

/** 配置快照的类型 */
export type WebuiConfig = ReturnType<typeof webuiConfigSchema.parse>
