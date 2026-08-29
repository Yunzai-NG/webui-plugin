/**
 * 模块职责：面板前端的构建配置
 * 依赖方向：构建期依赖 vite 与 vue 插件
 * 生命周期：构建期
 * 注意事项：**产物落在 `../dist/web`，与插件入口 `dist/index.js` 同级。**
 *          `src/index.ts` 以 `import.meta.dirname` 定位该目录，两处必须一致。
 *          此前产物直接写进内核包目录（`packages/core/webui`），面板因此无法脱离
 *          内核分发；面板独立成插件后该耦合消失。
 *
 *          `base: "./"` 配合哈希路由：产物内的资源引用全为相对路径，
 *          因此面板挂在任何前缀之下均可用（反向代理置于 `/yunzai/` 之下是常见需求）。
 *
 *          dev 模式将 `/api` 代理至内核默认端口并开启 ws —— 日志页需要真实的
 *          WebSocket 推送，mock 数据看不出「断开后订阅是否摘净」这类问题。
 */
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"

export default defineConfig({
  base: "./",
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    // 面板是本机应用，没有 CDN 缓存与首屏预算的问题；保留 sourcemap
    // 换来的是使用者报错时能直接指到源码行
    sourcemap: true,
    chunkSizeWarningLimit: 1024
  },
  server: {
    port: 5273,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:2536",
        changeOrigin: true,
        ws: true
      }
    }
  }
})
