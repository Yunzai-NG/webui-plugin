/**
 * 模块职责：`logline.ts` 的用例 —— 显示宽度、折行行数与「头部 + 省略号 + 尾部两字」
 * 依赖方向：测试文件，只依赖被测模块
 * 生命周期：纯函数，无夹具
 * 注意事项：本模块是整个面板里唯一一处「凭字符串算版面」的逻辑，而算错不会报错，
 *          只会表现为「有的行三行高、有的行截得太狠」——那种偏差在截图里也很难看出，
 *          因此这里逐条钉住它的边界。
 *
 *          尤其钉住**折行**：按「总宽度 ÷ 列宽」算是不成立的 —— 一串以空格分隔的长 URL
 *          总宽度恰好两行，实测占五行。此处以最小的例子把那种情形固定下来。
 */
import { describe, expect, it } from "vitest"
import { elide, linesOf, widthOf } from "./logline.js"

describe("显示宽度", () => {
  it("半角一位、全角两位", () => {
    expect(widthOf("abc")).toBe(3)
    expect(widthOf("插件")).toBe(4)
    expect(widthOf("失败 index.json")).toBe(4 + 1 + 10)
  })

  it("全角标点与全角字母同样按两位计", () => {
    expect(widthOf("（推荐）")).toBe(8)
    expect(widthOf("Ａ")).toBe(2)
  })

  it("辅助平面的表意文字按两位计，且不被拆成两个代理项", () => {
    expect("𠀋".length).toBe(2)
    expect(widthOf("𠀋")).toBe(2)
  })
})

describe("折行行数", () => {
  it("短文本一行", () => {
    expect(linesOf("abcd", 10)).toBe(1)
  })

  it("换行符强制断行", () => {
    expect(linesOf("ab\ncd", 10)).toBe(2)
    expect(linesOf("ab\n\ncd", 10)).toBe(3)
  })

  it("全角字符两侧可断行，因此中文能填满每一行", () => {
    // 每行 10 位 = 5 个汉字；12 个汉字正好三行
    expect(linesOf("一二三四五六七八九十十一", 10)).toBe(3)
  })

  it("**放不下的整词挪到下一行**，本行就此空着 —— 按总宽度算会漏掉这一类", () => {
    // 每行 10 位。"abcde" 5 位，空格 1 位，"fghijkl" 7 位放不下 → 换行
    // 总宽度 13 位（不足两行），但实际占两行
    expect(widthOf("abcde fghijkl")).toBe(13)
    expect(linesOf("abcde fghijkl", 10)).toBe(2)
  })

  it("以空格分隔的长词各占一行，行数远多于「总宽度 ÷ 列宽」", () => {
    const text = "aaaaaaaa bbbbbbbb cccccccc dddddddd"
    // 总宽 35 位，列宽 10 位 —— 按总宽度算是 4 行，实际每个词各占一行共 4 行；
    // 列宽 12 位时按总宽度算是 3 行，实际仍是 4 行
    expect(linesOf(text, 12)).toBe(4)
  })

  it("比一整行还长的词被就地拆开", () => {
    expect(linesOf("a".repeat(25), 10)).toBe(3)
  })

  it("行尾空白悬挂，不额外占一行", () => {
    expect(linesOf("abcdefghij ", 10)).toBe(1)
  })

  it("cols 非正时返回 0，供尚未量出列宽的场合短路", () => {
    expect(linesOf("随便", 0)).toBe(0)
  })
})

describe("截断", () => {
  it("两行以内原样返回", () => {
    const text = "命令 mock-adapter:#ping 处理完毕，耗时 3ms"
    expect(elide(text, 60)).toBe(text)
  })

  it("超出两行时保留尾部两字并以省略号相连，且结果确实只占两行", () => {
    const text = "一二三四五六七八九十".repeat(6) + "末尾"
    const out = elide(text, 20, 2)
    expect(out.endsWith("…末尾")).toBe(true)
    expect(linesOf(out, 20)).toBeLessThanOrEqual(2)
  })

  it("以空格分隔的长 URL 串：截断后仍是两行，尾部可读", () => {
    const text = `GET ${"https://example.invalid/a/b/c ".repeat(8)}404`
    const out = elide(text, 40, 2)
    expect(out.endsWith("…04")).toBe(true)
    // 按总宽度算这里会得到五行，CSS 兜底把尾部一起裁掉
    expect(linesOf(out, 40)).toBeLessThanOrEqual(2)
  })

  it("含换行的记录（带堆栈）截断后不含换行，因此不占额外行", () => {
    const text = `出错了\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)\n    at baz (c.js:3:3)`
    const out = elide(text, 40, 2)
    expect(out).not.toBe(text)
    expect(out.includes("\n")).toBe(false)
    expect(linesOf(out, 40)).toBeLessThanOrEqual(2)
  })

  it("尾部不留悬空的空格：截断处恰是空格时把它去掉", () => {
    const out = elide(`${"a".repeat(30)} ${"b".repeat(30)}`, 12, 2)
    expect(out.includes(" …")).toBe(false)
  })

  it("列宽小到连尾部都放不下时，只余省略号与尾部", () => {
    expect(elide("abcdefghij", 2, 1)).toBe("…ij")
  })

  it("cols 或 maxLines 非正时原样返回，不做处理", () => {
    expect(elide("abcdefghij", 0)).toBe("abcdefghij")
    expect(elide("abcdefghij", 10, 0)).toBe("abcdefghij")
  })
})
