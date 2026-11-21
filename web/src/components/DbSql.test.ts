import { describe, expect, it, vi } from "vitest"
import { createRenderer, h, nextTick, ref } from "vue"
import DbSql from "./DbSql.vue"
import { DB_PAGE, execOn } from "../dbpage.js"
import { askConfirm } from "../confirm.js"
import { ROWID_ALIAS } from "../storage.js"
import type { SqlResult } from "../types.js"

vi.mock("../api.js", () => ({ get: async () => ({ databases: [], tables: [] }) }))
vi.mock("../confirm.js", () => ({ askConfirm: vi.fn() }))
vi.mock("../dbpage.js", async original => ({ ...await original<typeof import("../dbpage.js")>(), execOn: vi.fn() }))

const renderer = createRenderer<object, object>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
  setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null
})
const table = { name: "same", type: "table", rowid: true, columns: [] }
const rows = { columns: [ROWID_ALIAS], rows: [[17]] } as SqlResult

/** 运行真实组件的 setup，不渲染 DOM 或连接服务器。 */
function mount() {
  const app = renderer.createApp({ render: () => h({ ...DbSql, render: () => null }) })
  app.provide(DB_PAGE, { error: ref(""), busy: ref(false), readonly: ref(false), copy: async () => {} })
  const root = app.mount({})
  const state = (root.$.subTree.component as unknown as { setupState: {
    pickDb(key: string): Promise<void>; browse(t: typeof table): Promise<void>; removeRow(i: number): Promise<void>
    result?: SqlResult; openRow(index: number): void; saveRow(): Promise<void>
  } }).setupState
  return { state, close: () => app.unmount() }
}

describe("SQLite 视图目标隔离", () => {
  it("A 的迟到查询不能填回 B，旧 rowid 不可删", async () => {
    const { state, close } = mount()
    try {
      await nextTick(); await state.pickDb("A")
      let finish!: (r: SqlResult) => void
      vi.mocked(execOn).mockReset().mockImplementationOnce(() => new Promise(r => { finish = r }))
      const late = state.browse(table)
      await state.pickDb("B"); finish(rows); await late
      expect(state.result).toBeUndefined()
      await state.removeRow(0)
      expect(execOn).toHaveBeenCalledTimes(1)
    } finally { close() }
  })
  it("切库使已打开的草稿与等待确认的删除失效，包括切回同一个库", async () => {
    const { state, close } = mount()
    try {
      await nextTick(); await state.pickDb("A")
      vi.mocked(execOn).mockReset().mockResolvedValue(rows)
      await state.browse(table); state.openRow(0)
      await state.pickDb("B"); await state.saveRow()
      expect(execOn).toHaveBeenCalledTimes(2)
      await state.pickDb("A"); await state.browse(table)
      let confirm!: (v: boolean) => void
      vi.mocked(askConfirm).mockImplementationOnce(() => new Promise(r => { confirm = r }))
      const pending = state.removeRow(0)
      await state.pickDb("B"); await state.pickDb("A"); confirm(true); await pending
      expect(execOn).toHaveBeenCalledTimes(4)
    } finally { close() }
  })
})
