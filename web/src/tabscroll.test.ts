/**
 * 模块职责：`tabscroll.ts` 的用例 —— 这一次滚轮该不该接手、接手多少
 * 依赖方向：测试文件，只依赖被测模块
 * 生命周期：纯函数，无夹具
 * 注意事项：**重点全在「不接手」那四条上。** 接手算错了一眼看得见（页签条不动），
 *          而误接手不报任何错，只表现为「指针停在这一条上时整页都滚不动了」——
 *          使用者会以为页面卡死，而他只是把鼠标放在了页签上。
 *
 *          尤其是**尽头那两条**：滚到最右仍接手，往下滚就此再无反应。故两个方向各有用例，
 *          且都验到「刚好在尽头」与「还差一点」两侧。
 */
import { describe, expect, it } from "vitest"
import { revealLeft, wheelShift } from "./tabscroll.js"

/** 一个溢出 120px 的页签条 */
const OVER = { scrollWidth: 800, clientWidth: 680, scrollLeft: 0 }

describe("滚轮转横滚", () => {
  it("竖滚轮在溢出的页签条上换算为横滚，原样取竖向分量", () => {
    expect(wheelShift(OVER, { deltaX: 0, deltaY: 100 })).toBe(100)
    expect(wheelShift({ ...OVER, scrollLeft: 60 }, { deltaX: 0, deltaY: -40 })).toBe(-40)
  })

  it("**没溢出时不接手** —— 一排页签全在眼前，接手只会让页面在这一条上滚不动", () => {
    expect(wheelShift({ scrollWidth: 680, clientWidth: 680, scrollLeft: 0 }, { deltaX: 0, deltaY: 100 })).toBeUndefined()
    // 可见宽反而更大（子像素舍入下确有此事）：同样不接手
    expect(wheelShift({ scrollWidth: 679, clientWidth: 680, scrollLeft: 0 }, { deltaX: 0, deltaY: 100 })).toBeUndefined()
  })

  it("**横向分量占主导时不接手** —— 触控板横扫由浏览器原生处理，再叠一次就是双倍速", () => {
    expect(wheelShift(OVER, { deltaX: 30, deltaY: 10 })).toBeUndefined()
    // 两者相等也让给浏览器：那多半是斜向惯性滑动
    expect(wheelShift(OVER, { deltaX: 20, deltaY: 20 })).toBeUndefined()
  })

  it("**已在最右时往下滚不接手** —— 否则指针停在页签条上，整页从此不动", () => {
    const room = OVER.scrollWidth - OVER.clientWidth
    expect(wheelShift({ ...OVER, scrollLeft: room }, { deltaX: 0, deltaY: 100 })).toBeUndefined()
    // 还差 10px 时仍接手：不能提前交回，那 10px 正是最后一个页签露不出来的部分
    expect(wheelShift({ ...OVER, scrollLeft: room - 10 }, { deltaX: 0, deltaY: 100 })).toBe(100)
  })

  it("**已在最左时往上滚不接手** —— 同一条道理的另一头", () => {
    expect(wheelShift({ ...OVER, scrollLeft: 0 }, { deltaX: 0, deltaY: -100 })).toBeUndefined()
    expect(wheelShift({ ...OVER, scrollLeft: 40 }, { deltaX: 0, deltaY: -100 })).toBe(-100)
  })

  it("尽头判定留 1px 容差 —— 缩放后的页面里滚动位置是小数，严格相等几乎永不成立", () => {
    const room = OVER.scrollWidth - OVER.clientWidth
    expect(wheelShift({ ...OVER, scrollLeft: room - 0.5 }, { deltaX: 0, deltaY: 100 })).toBeUndefined()
    expect(wheelShift({ ...OVER, scrollLeft: 0.5 }, { deltaX: 0, deltaY: -100 })).toBeUndefined()
  })

  it("竖向分量为零时不接手：纯横扫或缩放，没有可换算的量", () => {
    expect(wheelShift(OVER, { deltaX: 0, deltaY: 0 })).toBeUndefined()
  })
})

describe("选中项滚进视野", () => {
  /** 可见 400、溢出 400 的页签条，渐隐按缺省 28px */
  const BAR = { scrollWidth: 800, clientWidth: 400, scrollLeft: 0 }

  it("已完整露出且不压在渐隐下时不动", () => {
    expect(revealLeft(BAR, { left: 100, width: 80 })).toBeUndefined()
  })

  it("在右侧溢出区里：滚到它右缘再让出一道渐隐", () => {
    expect(revealLeft(BAR, { left: 500, width: 80 })).toBe(500 + 80 + 28 - 400)
  })

  it("**只压在右侧渐隐下也要挪** —— 那一截看着像被裁掉", () => {
    expect(revealLeft(BAR, { left: 320, width: 80 })).toBe(28)
  })

  it("在左侧溢出区里：滚到它左缘前让出一道渐隐", () => {
    expect(revealLeft({ ...BAR, scrollLeft: 300 }, { left: 250, width: 80 })).toBe(222)
  })

  it("目标夹在 0 与最大滚动量之间", () => {
    expect(revealLeft({ ...BAR, scrollLeft: 20 }, { left: 4, width: 80 })).toBe(0)
  })

  it("**夹到边界后无须移动时不动** —— 两端的渐隐在尽头不画，此时它已可见", () => {
    // 第一枚，已在最左
    expect(revealLeft(BAR, { left: 4, width: 80 })).toBeUndefined()
    // 最后一枚，已在最右
    expect(revealLeft({ ...BAR, scrollLeft: 400 }, { left: 716, width: 80 })).toBeUndefined()
    // 没溢出：贴着右缘的那枚也不动
    expect(revealLeft({ scrollWidth: 400, clientWidth: 400, scrollLeft: 0 }, { left: 330, width: 66 })).toBeUndefined()
  })
})
