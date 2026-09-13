import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./api.js", () => ({
  get: vi.fn(), getAt: vi.fn(), request: vi.fn(),
  ApiError: class extends Error {
    constructor(_status: number, message: string) { super(message) }
  }
}))
import { get, request, ApiError } from "./api.js"
import { attachBridge } from "./custombridge.js"

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach(fn => fn())
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

function mount(allowed = true) {
  let listener!: (event: MessageEvent) => void
  vi.stubGlobal("window", {
    addEventListener: (_name: string, handler: (e: MessageEvent) => void) => { listener = handler },
    removeEventListener: vi.fn()
  })
  let owner = "gscore-adapter"
  const source = { postMessage: vi.fn() }
  const frame = { contentWindow: source } as unknown as HTMLIFrameElement
  const detach = attachBridge(() => frame, () => owner, () => allowed)
  cleanup.push(detach)
  return {
    source, detach,
    change: () => { owner = "other" },
    send: (data: Record<string, unknown>, from: unknown = source) =>
      listener({ source: from, data: { kind: "yunzai-ng.custom", id: "test", ...data } } as MessageEvent)
  }
}

describe("受限配置桥", () => {
  it("只将已授权页面的 PATCH 交给内核配置 API", async () => {
    const r = mount()
    vi.mocked(request).mockResolvedValue({ value: { enable: false } })
    r.send({ config: true, method: "PATCH", body: { enable: false } })
    await vi.waitFor(() => expect(r.source.postMessage).toHaveBeenCalled())
    expect(request).toHaveBeenCalledWith("PATCH", "config/gscore-adapter", { enable: false })
    expect(r.source.postMessage).toHaveBeenCalledWith({
      kind: "yunzai-ng.custom", id: "test", ok: true, data: { value: { enable: false } }
    }, "*")
  })

  it("内核拒绝只读写入时向页面返回失败，不伪报成功", async () => {
    const r = mount()
    vi.mocked(request).mockRejectedValue(new ApiError(403, "只读模式"))
    r.send({ config: true, method: "PATCH", body: {} })
    await vi.waitFor(() => expect(r.source.postMessage).toHaveBeenCalled())
    expect(r.source.postMessage.mock.calls[0]?.[0]).toMatchObject({ ok: false, error: "只读模式" })
  })

  it("拒绝其他窗口与未授权页面，不向 API 发请求", () => {
    const r = mount(false)
    r.send({ config: true }, {})
    expect(r.source.postMessage).not.toHaveBeenCalled()
    r.send({ config: true })
    expect(r.source.postMessage.mock.calls[0]?.[0]).toMatchObject({ ok: false })
    expect(request).not.toHaveBeenCalled()
  })

  it("切换页面后不把上一页配置交给新页面", async () => {
    const r = mount()
    let resolve!: (data: unknown) => void
    vi.mocked(request).mockImplementation(() => new Promise(done => { resolve = done }) as any)
    r.send({ config: true })
    r.change()
    resolve({ value: { token: "secret" } })
    await Promise.resolve()
    await Promise.resolve()
    expect(r.source.postMessage).not.toHaveBeenCalled()
  })

  it("原有 accounts 只读请求仍可用", async () => {
    const r = mount()
    vi.mocked(get).mockResolvedValue([])
    r.send({ path: "accounts" })
    await vi.waitFor(() => expect(r.source.postMessage).toHaveBeenCalled())
    expect(get).toHaveBeenCalledWith("accounts")
    expect(request).not.toHaveBeenCalled()
  })
})