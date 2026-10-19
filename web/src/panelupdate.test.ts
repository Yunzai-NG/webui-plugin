import { describe, expect, it, vi } from "vitest"
import type { PanelStoreItem } from "./types.js"

const mocks = vi.hoisted(() => ({ ask: vi.fn(), post: vi.fn() }))
vi.mock("./confirm.js", () => ({ askConfirm: mocks.ask }))
vi.mock("./api.js", () => ({ postAt: mocks.post }))

const { askPanelUpdate, postPanelUpdate } = await import("./panelupdate.js")

const item: PanelStoreItem = {
  name: "hardware",
  title: "硬件信息",
  description: "十枚组件",
  version: "0.4.0",
  installedVersion: "0.3.1",
  installed: true,
  updatable: true,
  official: true,
  tags: [],
  source: "https://example.test/index.json",
  server: true,
  deps: true,
  setup: { scripts: ["build"], dev: true }
}

describe("面板插件更新", () => {
  it("确认列明版本、暂存、构建与重载要求，取消不发更新请求", async () => {
    mocks.ask.mockResolvedValue(false)
    mocks.post.mockClear()
    expect(await askPanelUpdate(item)).toBe(false)
    const request = mocks.ask.mock.calls.at(-1)?.[0] as { details: string[] }
    expect(request.details.join("\n")).toContain("0.3.1 → 0.4.0")
    expect(request.details.join("\n")).toContain("自动暂存")
    expect(request.details.join("\n")).toContain("build")
    expect(request.details.join("\n")).toContain("重载 webui")
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it("更新时执行依赖与构建，并给出下一步提示", async () => {
    mocks.post.mockResolvedValue({ name: "hardware", dir: "/plugins/webui/plugins/hardware", version: "0.4.0", fromVersion: "0.3.1", via: "pull", changed: true, needsDependencies: false, hasServer: true, updatable: "pull" })
    const text = await postPanelUpdate(item)
    expect(mocks.post).toHaveBeenLastCalledWith("/plugin/webui/panelstore/hardware/update", { dependencies: true })
    expect(text).toContain("0.3.1 → 0.4.0")
    expect(text).toContain("重载 webui")
  })

  it("纯浏览器包不跑依赖，确认提示刷新即可", async () => {
    mocks.ask.mockResolvedValue(true)
    const browserOnly = { ...item, server: false, deps: false, setup: undefined }
    await askPanelUpdate(browserOnly)
    const request = mocks.ask.mock.calls.at(-1)?.[0] as { details: string[] }
    expect(request.details.join("\n")).toContain("刷新页面生效")
    await postPanelUpdate(browserOnly)
    expect(mocks.post).toHaveBeenLastCalledWith("/plugin/webui/panelstore/hardware/update", { dependencies: false })
  })
})
