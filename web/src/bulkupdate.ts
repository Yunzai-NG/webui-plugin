/**
 * 模块职责：「全部更新」的并发池与结果汇总
 * 依赖方向：不依赖任何东西，纯逻辑
 * 生命周期：无状态
 * 注意事项：**限并发而不是一次全发**：每个更新都是一次 git 拉取，可能接着一次包管理器安装与编译，
 *          十几个同时跑会把低配机器（Termux）的内存与网络一并挤满，反而比排队慢。
 *
 *          一个失败不拖住别的：每项各自记成败，汇总时一并说。
 */

/** 并发上限 */
export const BULK_CONCURRENCY = 3

/** 一项的结果 */
export interface BulkOutcome {
  /** 名字，汇总时用 */
  readonly name: string
  /** 是否成功 */
  readonly ok: boolean
  /** 成功时的回执或失败原因 */
  readonly text: string
}

/**
 * 按并发上限跑完一组任务
 *
 * 结果按传入顺序排，与完成先后无关：汇总里的顺序跟卡片上一致才好对。
 * @param items 任务
 * @param limit 并发上限
 * @param work 跑一项，抛错即记为失败
 * @param nameOf 抛错时用来记名字
 * @returns 每项的结果
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<BulkOutcome>,
  nameOf: (item: T) => string
): Promise<BulkOutcome[]> {
  const out: BulkOutcome[] = new Array<BulkOutcome>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++
      const item = items[at] as T
      try {
        out[at] = await work(item)
      } catch (err) {
        out[at] = { name: nameOf(item), ok: false, text: err instanceof Error ? err.message : String(err) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
  return out
}

/**
 * 把一批结果说成一句话
 * @param outcomes 结果
 * @param skipped 因目录有改动而跳过的
 * @returns 提示
 */
export function bulkSummary(outcomes: readonly BulkOutcome[], skipped: readonly string[] = []): string {
  const ok = outcomes.filter(o => o.ok).map(o => o.name)
  const bad = outcomes.filter(o => !o.ok)
  const parts = [ok.length > 0 ? `已更新 ${ok.length} 个：${ok.join("、")}` : "没有更新成功的插件"]
  if (bad.length > 0) parts.push(`失败 ${bad.length} 个：${bad.map(o => `${o.name}（${o.text}）`).join("；")}`)
  if (skipped.length > 0) parts.push(`目录有改动而跳过 ${skipped.length} 个：${skipped.join("、")}`)
  return `${parts.join("。")}。`
}
