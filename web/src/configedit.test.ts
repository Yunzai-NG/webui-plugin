/**
 * 模块职责：`configedit.ts` 的用例 —— 补丁展开、深拷贝、以及「这次能不能用补丁」的判定
 * 依赖方向：测试文件，依赖被测模块
 * 生命周期：无状态
 * 注意事项：`needsReplace` 一节是本文件的重点。它判错的两种方向代价不同：
 *          **判漏**（该整份替换却发了补丁）表现为「删掉一行、保存、刷新，那一行原样回来」，
 *          即曾经修掉的那个缺陷；**判过**（不该整份替换却发了整份）表现为静默覆盖别处
 *          对同一文件的手改。故两个方向各有用例。
 */
import { describe, expect, it } from "vitest"
import { assignPath, buildPatch, defaultsOf, isPlainObject, needsReplace, pickPath, snapshot } from "./configedit.js"

describe("配置编辑取值", () => {
  describe("补丁展开", () => {
    it("点号路径展开为嵌套对象 —— 直接提交平铺的键会被当成一个顶层字段", () => {
      expect(buildPatch({ "server.port": 3000 })).toEqual({ server: { port: 3000 } })
    })

    it("同一父节点下的多个字段并入同一个对象", () => {
      expect(buildPatch({ "server.port": 3000, "server.host": "0.0.0.0" })).toEqual({
        server: { port: 3000, host: "0.0.0.0" }
      })
    })

    it("三层以上照样展开", () => {
      expect(buildPatch({ "a.b.c.d": 1 })).toEqual({ a: { b: { c: { d: 1 } } } })
    })

    it("顶层字段原样保留", () => {
      expect(buildPatch({ debug: true })).toEqual({ debug: true })
    })

    it("父路径已被非对象占住时改写成对象 —— 否则后一条会静默丢失", () => {
      expect(buildPatch({ a: 1, "a.b": 2 })).toEqual({ a: { b: 2 } })
    })

    it("无改动时给空对象", () => {
      expect(buildPatch({})).toEqual({})
    })
  })

  describe("深拷贝", () => {
    it("拷出来的对象与原对象互不影响", () => {
      const origin = { a: { b: 1 } }
      const copy = snapshot(origin)
      copy.a = { b: 2 }
      expect(origin.a.b).toBe(1)
    })

    it("嵌套层也是新对象，不是同一个引用", () => {
      const origin = { a: { b: [1, 2] } }
      const copy = snapshot(origin)
      expect(copy.a).not.toBe(origin.a)
      expect(copy).toEqual(origin)
    })
  })

  describe("按路径取值", () => {
    it("取得到嵌套值", () => {
      expect(pickPath({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7)
    })

    it("中途断开时给 undefined，不抛错", () => {
      expect(pickPath({ a: 1 }, "a.b.c")).toBeUndefined()
      expect(pickPath({}, "nope")).toBeUndefined()
    })
  })

  describe("要不要整份替换", () => {
    it("**字典少了一个键就要整份替换** —— 这正是曾经修掉的那个缺陷", () => {
      const pristine = { alias: { a: "1", b: "2" } }
      expect(needsReplace({ alias: { a: "1" } }, pristine)).toBe(true)
    })

    it("字典只是改了值，补丁足够 —— 整份替换会覆盖别处的手改", () => {
      const pristine = { alias: { a: "1", b: "2" } }
      expect(needsReplace({ alias: { a: "9", b: "2" } }, pristine)).toBe(false)
    })

    it("字典只是加了键，补丁足够", () => {
      const pristine = { alias: { a: "1" } }
      expect(needsReplace({ alias: { a: "1", b: "2" } }, pristine)).toBe(false)
    })

    it("标量与数组的改动一律走补丁", () => {
      expect(needsReplace({ port: 3000 }, { port: 2536 })).toBe(false)
      expect(needsReplace({ list: [1] }, { list: [1, 2, 3] })).toBe(false)
    })

    it("原先没有这个路径时走补丁 —— 无从谈起「少了键」", () => {
      expect(needsReplace({ "a.b": { x: 1 } }, {})).toBe(false)
    })

    it("嵌套路径上的字典同样判得出", () => {
      const pristine = { bot: { alias: { a: "1", b: "2" } } }
      expect(needsReplace({ "bot.alias": { a: "1" } }, pristine)).toBe(true)
    })

    it("无改动时不必替换", () => {
      expect(needsReplace({}, { a: 1 })).toBe(false)
    })
  })

  describe("就地写值", () => {
    it("写得进嵌套路径", () => {
      const value: Record<string, unknown> = { server: { port: 2536 } }
      expect(assignPath(value, "server.port", 3000)).toBe(true)
      expect(value).toEqual({ server: { port: 3000 } })
    })

    it("**中途不是对象时放弃写入，不造中间层** —— 造出 schema 里没有的对象会让报错离原因更远", () => {
      const value: Record<string, unknown> = { server: 1 }
      expect(assignPath(value, "server.port", 3000)).toBe(false)
      expect(value).toEqual({ server: 1 })
    })

    it("顶层字段写得进", () => {
      const value: Record<string, unknown> = {}
      expect(assignPath(value, "debug", true)).toBe(true)
      expect(value.debug).toBe(true)
    })
  })

  describe("普通对象判定", () => {
    it("数组与 null 都不算普通对象 —— 两者都会让「少了键」误判", () => {
      expect(isPlainObject({})).toBe(true)
      expect(isPlainObject([])).toBe(false)
      expect(isPlainObject(null)).toBe(false)
      expect(isPlainObject("x")).toBe(false)
    })
  })

  /*
   * 铺默认值
   *
   * 重点在**没声明默认值的字段不出现**：铺一个 `null` 或空串进去，那就是「使用者明确填了
   * 这个值」，会连着提交上去 —— 而 schema 里的可选字段本该缺席。这一条错了不报错，
   * 只表现为「新建账号时莫名多提交了几个空字段」。
   */
  describe("铺默认值", () => {
    it("按声明铺出默认值", () => {
      const schema = {
        type: "object",
        properties: {
          url: { type: "string", default: "ws://127.0.0.1:3001" },
          timeout: { type: "string", default: "15s" }
        }
      }
      expect(defaultsOf(schema)).toEqual({ url: "ws://127.0.0.1:3001", timeout: "15s" })
    })

    it("**没声明 default 的字段不出现**，也不填 null 或空串", () => {
      const schema = {
        type: "object",
        properties: {
          url: { type: "string", default: "ws://x" },
          token: { type: "string" },
          note: { type: "string", default: undefined }
        }
      }
      expect(defaultsOf(schema)).toEqual({ url: "ws://x" })
    })

    it("false 与 0 是货真价实的默认值，不能被当成「没声明」", () => {
      const schema = {
        type: "object",
        properties: {
          quiet: { type: "boolean", default: false },
          retries: { type: "number", default: 0 }
        }
      }
      expect(defaultsOf(schema)).toEqual({ quiet: false, retries: 0 })
    })

    it("对象逐层递归", () => {
      const schema = {
        type: "object",
        properties: {
          net: { type: "object", properties: { port: { type: "number", default: 3001 } } }
        }
      }
      expect(defaultsOf(schema)).toEqual({ net: { port: 3001 } })
    })

    it("**一项默认值都没有的对象不留空壳** —— 那会让「有没有改过」的判定多一层噪声", () => {
      const schema = {
        type: "object",
        properties: {
          net: { type: "object", properties: { host: { type: "string" } } }
        }
      }
      expect(defaultsOf(schema)).toEqual({})
    })

    it("**铺出来的是副本** —— 改它不该动到 schema 里那份声明", () => {
      const shared = ["#", "*"]
      const schema = { type: "object", properties: { prefix: { type: "array", default: shared } } }
      const got = defaultsOf(schema)
      ;(got.prefix as string[]).push("%")
      expect(shared).toEqual(["#", "*"])
    })

    it("没有 properties 时给空对象而非抛错", () => {
      expect(defaultsOf({ type: "object" })).toEqual({})
      expect(defaultsOf({})).toEqual({})
    })
  })
})
