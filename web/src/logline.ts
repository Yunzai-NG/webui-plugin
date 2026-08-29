/**
 * 模块职责：日志正文的定宽截断 —— 按浏览器的折行规则算行，超出两行即省略且保留尾部字符
 * 依赖方向：无依赖，纯函数
 * 生命周期：无状态
 * 注意事项：**不全靠 CSS 的 `-webkit-line-clamp`**：它的省略号只出现在末尾，丢掉的永远是
 *          文本的尾巴 —— 而日志的尾巴常是要看的那一段（错误码、URL 的最后一节、耗时数值）。
 *          故在字符串层面做出「头部 + 省略号 + 尾部两字」，`line-clamp` 仅作硬上限兜底。
 *
 *          **必须模拟折行，不能按总宽度除以列宽**：一串以空格分隔的长 URL 总宽度恰等于两行，
 *          实测却占五行 —— 每行末尾都因「下一个词放不下」而提前结束。故按浏览器的规则贪心
 *          排版：空格与全角字符处可断行，比整行还长的词由 `word-break: break-word` 拆开。
 *
 *          **这一模型立在「日志区是等宽字族」之上**：等宽下半角步进一致、全角恰为两倍，
 *          故「宽度 = 字符数 × 步进」是等式而非估算。改用比例字族时本模块须一并废弃。
 */

/** 省略号，等宽字族里占一个半角位 */
const ELLIPSIS = "…"

/** 省略后仍要显示的尾部字符数 */
const TAIL_CHARS = 2

/**
 * 单个字符的显示宽度
 *
 * 只分半角与全角两档，不追求 Unicode 东亚宽度表的完整性：差一位不改变观感，而完整宽度表
 * 要多带数 KB。命中的区段覆盖 CJK、假名、韩文音节与全角标点。
 * @param code 字符的 Unicode 码点
 * @returns 显示宽度，1 或 2
 */
export function widthOfCode(code: number): 1 | 2 {
  if (code < 0x1100) return 1
  if (code >= 0x2e80 && code <= 0x303e) return 2
  if (code >= 0x3041 && code <= 0x33ff) return 2
  if (code >= 0x3400 && code <= 0x4dbf) return 2
  if (code >= 0x4e00 && code <= 0x9fff) return 2
  if (code >= 0xa000 && code <= 0xa4cf) return 2
  if (code >= 0xac00 && code <= 0xd7a3) return 2
  if (code >= 0xf900 && code <= 0xfaff) return 2
  if (code >= 0xfe30 && code <= 0xfe6f) return 2
  if (code >= 0xff00 && code <= 0xff60) return 2
  if (code >= 0xffe0 && code <= 0xffe6) return 2
  if (code >= 0x20000 && code <= 0x3fffd) return 2
  return 1
}

/**
 * 一段文本的显示宽度（不考虑折行）
 * @param text 文本
 * @returns 显示宽度，以半角位计
 */
export function widthOf(text: string): number {
  let total = 0
  for (const ch of text) total += widthOfCode(ch.codePointAt(0) ?? 0)
  return total
}

/** 一个排版单元 */
interface Token {
  /** 原文 */
  text: string
  /** 显示宽度 */
  width: number
  /** 换行符：强制断行 */
  br: boolean
  /** 空白：可在其后断行，且行尾空白悬挂不算溢出 */
  space: boolean
}

/**
 * 切分为排版单元
 *
 * 断行机会有三处：换行符、空白之后、全角字符两侧。半角连写的一段（URL、标识符）
 * 是一个整体，只有在它比一整行还长时才会被 `word-break: break-word` 拆开。
 * @param text 文本
 * @returns 排版单元序列
 */
function tokenize(text: string): Token[] {
  const out: Token[] = []
  let word = ""
  /** 收束当前正在累积的半角词 */
  const flush = (): void => {
    if (word !== "") out.push({ text: word, width: widthOf(word), br: false, space: false })
    word = ""
  }
  for (const ch of text) {
    if (ch === "\n") {
      flush()
      out.push({ text: ch, width: 0, br: true, space: false })
      continue
    }
    if (ch === " " || ch === "\t") {
      flush()
      out.push({ text: ch, width: ch === "\t" ? 4 : 1, br: false, space: true })
      continue
    }
    const w = widthOfCode(ch.codePointAt(0) ?? 0)
    if (w === 2) {
      flush()
      out.push({ text: ch, width: 2, br: false, space: false })
      continue
    }
    word += ch
  }
  flush()
  return out
}

/** 贪心排版的推进状态 */
interface Cursor {
  /** 已占用的行数，从 1 起 */
  line: number
  /** 当前行已用的半角位 */
  x: number
}

/**
 * 把一个排版单元放进版面，推进游标
 * @param cursor 游标，就地修改
 * @param token 排版单元
 * @param limitOf 取某一行的可用宽度
 */
function place(cursor: Cursor, token: Token, limitOf: (line: number) => number): void {
  if (token.br) {
    cursor.line += 1
    cursor.x = 0
    return
  }
  // 行尾空白悬挂：`pre-wrap` 下它不会把行撑出去，也不会自己换行
  if (token.space) {
    cursor.x += token.width
    return
  }
  let limit = limitOf(cursor.line)
  if (cursor.x > 0 && cursor.x + token.width > limit) {
    cursor.line += 1
    cursor.x = 0
    limit = limitOf(cursor.line)
  }
  if (cursor.x + token.width <= limit) {
    cursor.x += token.width
    return
  }
  // 比一整行还长的词：`word-break: break-word` 就地拆开，逐行填满
  let rest = token.width
  while (rest > 0) {
    const room = limit - cursor.x
    if (room <= 0) {
      cursor.line += 1
      cursor.x = 0
      limit = limitOf(cursor.line)
      continue
    }
    const take = Math.min(room, rest)
    cursor.x += take
    rest -= take
    if (rest > 0) {
      cursor.line += 1
      cursor.x = 0
      limit = limitOf(cursor.line)
    }
  }
}

/**
 * 文本按每行 `cols` 个半角位排版时占多少行
 * @param text 文本
 * @param cols 每行可容纳的半角位数
 * @returns 行数；`cols <= 0` 时为 0
 */
export function linesOf(text: string, cols: number): number {
  if (cols <= 0) return 0
  const cursor: Cursor = { line: 1, x: 0 }
  for (const token of tokenize(text)) place(cursor, token, () => cols)
  return cursor.line
}

/**
 * 把文本压到 `maxLines` 行以内，形态为「头部 + 省略号 + 尾部两字」
 *
 * 未超出时原样返回，因此调用方无须先自行判断。
 *
 * 尾部所需的宽度从**最后一行**的可用宽度里先扣掉，而不是等排完再回头找位置：
 * 这样凡是能放进来的头部，都必然留得下省略号与尾部，无须第二遍扫描。
 * @param text 文本
 * @param cols 每行可容纳的半角位数；`<= 0` 时不作处理（尚未量出列宽）
 * @param maxLines 最多几行，缺省 2
 * @returns 截断后的文本
 */
export function elide(text: string, cols: number, maxLines = 2): string {
  if (cols <= 0 || maxLines <= 0) return text
  if (linesOf(text, cols) <= maxLines) return text

  const chars = [...text]
  // 尾部里的换行换成空格：否则它会把尾部顶到再下一行，两行的承诺就破了
  const tail = chars.slice(-TAIL_CHARS).join("").replace(/[\n\t]/g, " ")
  const reserve = widthOf(ELLIPSIS) + widthOf(tail)
  if (reserve >= cols) return `${ELLIPSIS}${tail}`

  /** 末行要给省略号与尾部留位 */
  const limitOf = (line: number): number => (line >= maxLines ? cols - reserve : cols)

  const cursor: Cursor = { line: 1, x: 0 }
  let head = ""
  // 头部里的换行同样换成空格：省下的整行留给正文，读者要看的是内容不是空白
  for (const token of tokenize(text.replace(/\n/g, " "))) {
    const probe: Cursor = { line: cursor.line, x: cursor.x }
    place(probe, token, limitOf)
    if (probe.line > maxLines) break
    cursor.line = probe.line
    cursor.x = probe.x
    head += token.text
  }
  return `${head.replace(/\s+$/, "")}${ELLIPSIS}${tail}`
}
