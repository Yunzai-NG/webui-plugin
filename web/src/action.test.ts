/**
 * 模块职责：`action.ts` 的用例 —— 错误何时清、何时写，忙碌标记何时复位
 * 依赖方向：测试文件；api.js 换成桩，它在模块顶层读 localStorage，node 下没有
 * 生命周期：每条用例各取一份状态
 */
import { describe, expect, it, vi } from "vitest"
import { useAction } from "./action.js"

vi.mock("./api.js", () => ({ ApiError: class ApiError extends Error {} }))

describe("useAction", () => {
  it("进行中 busy 为那个键，结束后复位", async () => {
    const { busy, run } = useAction()
    let seen = ""
    await run("pkg-a", async () => {
      seen = busy.value
    })
    expect(seen).toBe("pkg-a")
    expect(busy.value).toBe("")
  })

  it("失败时写错误文案、复位 busy，且不往外抛", async () => {
    const { error, busy, run } = useAction()
    await expect(run("pkg-a", () => Promise.reject(new Error("网络断了")))).resolves.toBeUndefined()
    expect(error.value).toBe("网络断了")
    expect(busy.value).toBe("")
  })

  it("开始时清掉上一次的错误", async () => {
    const { error, run } = useAction()
    error.value = "上一次的错"
    let seen = "未执行"
    await run("pkg-a", async () => {
      seen = error.value
    })
    expect(seen).toBe("")
    expect(error.value).toBe("")
  })

  it("**任务里自己写的错误留着** —— 收尾重读列表失败的那句不能被成功盖掉", async () => {
    const { error, run } = useAction()
    await run("pkg-a", async () => {
      error.value = "列表读取失败"
    })
    expect(error.value).toBe("列表读取失败")
  })
})
