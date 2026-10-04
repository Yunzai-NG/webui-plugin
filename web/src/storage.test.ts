/**
 * 模块职责：数据库页纯逻辑的用例
 * 依赖方向：测试文件，依赖 storage.ts
 * 生命周期：无状态
 * 注意事项：SQL 拼装用例覆盖标识符的引号转义，转义错误即构成注入。
 */
import { describe, expect, it } from "vitest"
import {
  ROWID_ALIAS,
  browseSqlOf,
  cellEditText,
  cellParamOf,
  cellText,
  columnLabel,
  countAllSqlOf,
  countSqlOf,
  crumbsOf,
  deleteSqlOf,
  diffLines,
  diffStat,
  expireAtOf,
  foldDiff,
  insertSqlOf,
  isDestructiveSql,
  isSensitive,
  jsonBytes,
  kvTypeOf,
  parentOf,
  parseValueText,
  pushHistory,
  quoteIdent,
  reformatJson,
  resolveExpireAt,
  rowsAsObjects,
  sharesOf,
  sortKvItems,
  sqlTemplatesOf,
  sqlTokens,
  toCsv,
  ttlText,
  updateRowSqlOf,
  valueTextOf
} from "./storage.js"
import type { SqlColumn, SqlTable } from "./types.js"

describe("语句高亮切分", () => {
  it("拼接后与原文一致", () => {
    const sql = `CREATE TABLE "t" (id INTEGER PRIMARY KEY, name TEXT DEFAULT 'a''b') -- 注释\n/* 块 */`
    expect(sqlTokens(sql).map(t => t.text).join("")).toBe(sql)
  })

  it("区分关键字、字符串、数字、标识符与注释", () => {
    const kinds = sqlTokens(`SELECT "x", 'v', 42 FROM t -- c`)
      .filter(t => t.kind !== "plain")
      .map(t => [t.kind, t.text])
    expect(kinds).toEqual([
      ["kw", "SELECT"],
      ["ident", '"x"'],
      ["str", "'v'"],
      ["num", "42"],
      ["kw", "FROM"],
      ["comment", "-- c"]
    ])
  })

  it("关键字不分大小写，普通词按 plain", () => {
    const tokens = sqlTokens("select foo")
    expect(tokens[0]).toEqual({ text: "select", kind: "kw" })
    expect(tokens.at(-1)).toEqual({ text: "foo", kind: "plain" })
  })

  it("未闭合的字符串吃到末尾，不丢字", () => {
    const sql = "SELECT 'abc"
    const tokens = sqlTokens(sql)
    expect(tokens.at(-1)).toEqual({ text: "'abc", kind: "str" })
    expect(tokens.map(t => t.text).join("")).toBe(sql)
  })

  it("空串没有片段", () => {
    expect(sqlTokens("")).toEqual([])
  })
})

describe("前缀面包屑", () => {
  it("根前缀只有一节", () => {
    expect(crumbsOf("")).toEqual([{ label: "根", prefix: "" }])
  })

  it("逐节累加前缀", () => {
    expect(crumbsOf("plugin:webui:")).toEqual([
      { label: "根", prefix: "" },
      { label: "plugin", prefix: "plugin:" },
      { label: "webui", prefix: "plugin:webui:" }
    ])
  })

  it("空段给出可读的文案", () => {
    expect(crumbsOf("a::")[2]).toEqual({ label: "（空）", prefix: "a::" })
  })

  it("上一级退回前一节，根不再往上", () => {
    expect(parentOf("plugin:webui:")).toBe("plugin:")
    expect(parentOf("plugin:")).toBe("")
    expect(parentOf("")).toBe("")
  })
})

describe("敏感前缀", () => {
  it("账号与适配器之下默认隐去", () => {
    expect(isSensitive("accounts:record:a1")).toBe(true)
    expect(isSensitive("adapter:napcat:")).toBe(true)
    expect(isSensitive("plugin:webui:x")).toBe(false)
  })
})

describe("值的文本往返", () => {
  it("字符串走文本，其余走 JSON", () => {
    expect(valueTextOf("abc")).toEqual({ mode: "text", text: "abc" })
    expect(valueTextOf({ a: 1 })).toEqual({ mode: "json", text: '{\n  "a": 1\n}' })
    expect(valueTextOf(null)).toEqual({ mode: "json", text: "null" })
  })

  it("JSON 解析失败给出原因，不抛", () => {
    const bad = parseValueText("{a:", "json")
    expect(bad.ok).toBe(false)
    expect(parseValueText("", "json").ok).toBe(false)
    expect(parseValueText("[1,2]", "json")).toEqual({ ok: true, value: [1, 2] })
  })

  it("文本模式原样存成字符串，空串也收", () => {
    expect(parseValueText("", "text")).toEqual({ ok: true, value: "" })
    expect(parseValueText("123", "text")).toEqual({ ok: true, value: "123" })
  })

  it("重排可缩进也可压扁，无效 JSON 原样报错", () => {
    expect(reformatJson('{"a":1}', true)).toEqual({ ok: true, text: '{\n  "a": 1\n}' })
    expect(reformatJson('{\n  "a": 1\n}', false)).toEqual({ ok: true, text: '{"a":1}' })
    expect(reformatJson("{a:", true).ok).toBe(false)
  })

  it("值的大类与字节数与内核判定一致", () => {
    expect(kvTypeOf(null)).toBe("null")
    expect(kvTypeOf([1])).toBe("array")
    expect(kvTypeOf("x")).toBe("string")
    expect(kvTypeOf(1)).toBe("number")
    expect(kvTypeOf(true)).toBe("boolean")
    expect(kvTypeOf({})).toBe("object")
    expect(jsonBytes({ a: 1 })).toBe(7)
    expect(jsonBytes(undefined)).toBe(4)
  })
})

describe("过期时间", () => {
  it("空串即永不过期，非正数判为无效", () => {
    expect(expireAtOf("", 1000)).toBeUndefined()
    expect(expireAtOf("0", 1000)).toBeNull()
    expect(expireAtOf("-5", 1000)).toBeNull()
    expect(expireAtOf("abc", 1000)).toBeNull()
    expect(expireAtOf("1.5", 1000)).toBe(2500)
  })

  it("剩余时间按量级取单位", () => {
    expect(ttlText(undefined, 0)).toBe("")
    expect(ttlText(30_000, 0)).toBe("30秒后过期")
    expect(ttlText(5 * 60_000, 0)).toBe("5分后过期")
    expect(ttlText(2 * 3600_000 + 3 * 60_000, 0)).toBe("2小时3分后过期")
    expect(ttlText(26 * 3600_000, 0)).toBe("1天2小时后过期")
    // 已过点的不显示负数
    expect(ttlText(0, 10_000)).toBe("0秒后过期")
  })

  it("四档设置各自的结果", () => {
    expect(resolveExpireAt("keep", "", 5000, 1000)).toEqual({ ok: true, expireAt: 5000 })
    expect(resolveExpireAt("never", "", 5000, 1000)).toEqual({ ok: true, expireAt: undefined })
    expect(resolveExpireAt(3600, "", undefined, 1000)).toEqual({ ok: true, expireAt: 3_601_000 })
    expect(resolveExpireAt("custom", "60", undefined, 1000)).toEqual({ ok: true, expireAt: 61_000 })
    expect(resolveExpireAt("custom", "", undefined, 1000).ok).toBe(false)
    expect(resolveExpireAt("custom", "-1", undefined, 1000).ok).toBe(false)
  })
})

describe("键列表排序", () => {
  const items = [
    { key: "b", size: 30 },
    { key: "a", size: 10, expireAt: 2000 },
    { key: "c", size: 20, expireAt: 1000 }
  ]

  it("按名字、大小升降序", () => {
    expect(sortKvItems(items, "name", false).map(i => i.key)).toEqual(["a", "b", "c"])
    expect(sortKvItems(items, "size", true).map(i => i.key)).toEqual(["b", "c", "a"])
  })

  it("永不过期的排在最后", () => {
    expect(sortKvItems(items, "expire", false).map(i => i.key)).toEqual(["c", "a", "b"])
  })

  it("不改原数组", () => {
    sortKvItems(items, "name", false)
    expect(items[0]?.key).toBe("b")
  })
})

describe("逐行差异", () => {
  it("只改一行时只报那一行", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc")
    expect(lines).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "B" },
      { op: "same", text: "c" }
    ])
    expect(diffStat(lines)).toEqual({ add: 1, del: 1 })
  })

  it("相同文本无增删", () => {
    expect(diffStat(diffLines("a\nb", "a\nb"))).toEqual({ add: 0, del: 0 })
  })

  it("远离改动的未改动行折成一段", () => {
    const before = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n")
    const after = before.replace("L10", "X10")
    const folded = foldDiff(diffLines(before, after), 1)
    expect(folded[0]).toEqual({ op: "gap", count: 9 })
    expect(folded.filter(x => x.op === "add")).toHaveLength(1)
    expect(folded[folded.length - 1]).toEqual({ op: "gap", count: 8 })
  })
})

describe("命名空间占比", () => {
  it("按键数降序并算出比例", () => {
    expect(sharesOf([{ name: "a:", count: 1 }, { name: "b:", count: 3 }])).toEqual([
      { name: "b:", count: 3, ratio: 0.75 },
      { name: "a:", count: 1, ratio: 0.25 }
    ])
  })

  it("直属键数单列一项，为零时不出现", () => {
    expect(sharesOf([{ name: "a:", count: 1 }], 1).map(s => s.name)).toEqual(["", "a:"])
    expect(sharesOf([{ name: "a:", count: 1 }], 0)).toHaveLength(1)
  })

  it("全空时比例为零而非 NaN", () => {
    expect(sharesOf([{ name: "a:", count: 0 }])[0]?.ratio).toBe(0)
  })
})

describe("SQL 拼装", () => {
  const table: SqlTable = { name: 'we"ird', type: "table", rowid: true, columns: [] }

  it("标识符里的双引号成对转义", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })

  it("带 rowid 的表多取一列别名", () => {
    expect(browseSqlOf(table)).toBe(`SELECT rowid AS "${ROWID_ALIAS}", * FROM "we""ird" LIMIT ? OFFSET ?`)
    expect(browseSqlOf({ ...table, name: "v", type: "view", rowid: false })).toBe('SELECT * FROM "v" LIMIT ? OFFSET ?')
  })

  it("筛选与排序进子句，末尾分号去掉", () => {
    expect(browseSqlOf({ ...table, name: "t" }, { where: "a = 1;", orderBy: "a", desc: true })).toBe(
      `SELECT rowid AS "${ROWID_ALIAS}", * FROM "t" WHERE (a = 1) ORDER BY "a" DESC LIMIT ? OFFSET ?`
    )
    expect(browseSqlOf({ ...table, name: "t" }, { orderBy: ROWID_ALIAS })).toContain("ORDER BY rowid ASC")
  })

  it("统计行数共用同一套筛选", () => {
    expect(countSqlOf({ ...table, name: "t" }, " a = 1 ")).toBe('SELECT count(*) FROM "t" WHERE (a = 1)')
    expect(countAllSqlOf(["a", 'b"c'])).toBe(
      'SELECT (SELECT count(*) FROM "a") AS c0, (SELECT count(*) FROM "b""c") AS c1'
    )
  })

  it("改删只拼标识符，值走参数", () => {
    expect(updateRowSqlOf("t", ['c"1', "c2"])).toBe('UPDATE "t" SET "c""1" = ?, "c2" = ? WHERE rowid = ?')
    expect(deleteSqlOf("t")).toBe('DELETE FROM "t" WHERE rowid = ?')
  })

  it("插入按列数给占位，无列时取默认值", () => {
    expect(insertSqlOf("t", ["a", "b"])).toBe('INSERT INTO "t" ("a", "b") VALUES (?, ?)')
    expect(insertSqlOf("t", [])).toBe('INSERT INTO "t" DEFAULT VALUES')
  })

  it("删改类语句判为需二次确认，注释不影响判定", () => {
    expect(isDestructiveSql("delete from t")).toBe(true)
    expect(isDestructiveSql("  -- 说明\n DROP TABLE t")).toBe(true)
    expect(isDestructiveSql("/* x */ UPDATE t SET a = 1")).toBe(true)
    expect(isDestructiveSql("SELECT 1")).toBe(false)
    expect(isDestructiveSql("INSERT INTO t VALUES (1)")).toBe(false)
  })

  it("模板里的表名也经转义", () => {
    const list = sqlTemplatesOf("we'ird")
    expect(list[0]?.sql).toBe(`SELECT * FROM "we'ird" LIMIT 50`)
    expect(list[2]?.sql).toContain("'we''ird'")
    expect(sqlTemplatesOf(undefined)[0]?.sql).toContain('"表名"')
  })

  it("执行历史去重置顶并限长", () => {
    expect(pushHistory(["a", "b"], "b")).toEqual(["b", "a"])
    expect(pushHistory(["a"], "  ")).toEqual(["a"])
    expect(pushHistory(["a", "b", "c"], "d", 2)).toEqual(["d", "a"])
  })
})

describe("单元格", () => {
  it("NULL、二进制与对象各有显示", () => {
    expect(cellText(null)).toBe("NULL")
    expect(cellText({ $blob: 12, head: "00ff" })).toBe("<BLOB 12 字节>")
    expect(cellText(3)).toBe("3")
    expect(cellEditText(null)).toBe("")
    expect(columnLabel(ROWID_ALIAS)).toBe("rowid")
    expect(columnLabel("a")).toBe("a")
  })

  it("数值亲和列里像数字的按数字绑定", () => {
    const int: SqlColumn = { name: "n", type: "INTEGER", pk: 0, notnull: false }
    const text: SqlColumn = { name: "s", type: "TEXT", pk: 0, notnull: false }
    expect(cellParamOf("42", int, false)).toBe(42)
    expect(cellParamOf("4x", int, false)).toBe("4x")
    expect(cellParamOf("42", text, false)).toBe("42")
    expect(cellParamOf("", int, false)).toBe("")
    expect(cellParamOf("42", int, true)).toBeNull()
  })
})

describe("导出", () => {
  const columns = [ROWID_ALIAS, "a"]
  const rows = [
    [1, 'x,"y"'],
    [2, null]
  ]

  it("CSV 带表头，含分隔符的字段加引号", () => {
    expect(toCsv(columns, rows)).toBe('rowid,a\r\n1,"x,""y"""\r\n2,')
  })

  it("JSON 每行一个对象，NULL 保留", () => {
    expect(rowsAsObjects(columns, rows)).toEqual([
      { rowid: 1, a: 'x,"y"' },
      { rowid: 2, a: null }
    ])
  })
})
