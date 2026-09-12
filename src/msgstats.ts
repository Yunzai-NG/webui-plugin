/**
 * 模块职责：消息统计的纯逻辑 —— 按天分桶累加收发计数、裁剪过期天、按范围聚合
 * 依赖方向：**不依赖任何东西**（不 import 内核、不碰 fs、不读时钟以外的环境）
 * 生命周期：由 `msgcollect.ts` 持有一个 `StatsBuckets` 实例，随 webui 装卸
 * 注意事项：与 IO 分家是为了能测：判天界、跨天翻桶、裁剪、聚合都是「算错了也照样跑」的那类逻辑，
 *          而它们一旦错，界面上只是数字偏了，没有任何报错。IO 那一半在 `msgcollect.ts`。
 *
 *          **天界按本地时区切**，不用 UTC：使用者看「今天收了多少条」，指的是他墙上的今天。
 *          代价是改时区后旧桶的日期标签仍按当时的时区算，故 `dayKey` 只在写入时求一次。
 *
 *          **发出去的图片分不出是不是表情包。** 内核 `message/sent` 给的 `kinds` 是按段的
 *          `type` 聚合的计数（`{ image: 2 }`），而 QQ 的「表情图」是 `image` 段上的
 *          `subType === 1` —— 那一层信息在聚合时就没了。故发送侧只有 `image` 与 `face` 两项，
 *          `sticker` 恒为 0，界面须就此说明而不是让使用者以为「一张表情包都没发过」。
 *          收到的消息拿得到完整 `Segment[]`，故收侧三项齐全。
 */

/** 一条消息的分项计数，收发两侧同构 */
export interface Tally {
  /** 消息条数 */
  messages: number
  /** 图片段数（含表情图） */
  images: number
  /** 表情包段数：QQ 原生表情（`face`）加表情图（`image` 且 `subType === 1`） */
  stickers: number
}

/** 一对收发计数，按账号细分时的单元 */
export interface Pair {
  /** 收到的 */
  recv: Tally
  /** 发出的 */
  sent: Tally
}

/**
 * 一个会话在某一天的收发计数
 *
 * `by` 是按账号细分的同一份数据，键为 `platform:accountId`。**不把账号并进 `peer` 键**：
 * 那样同一个群会因为两个账号在里面而裂成两行，而「这个群一共多少条」就再也问不出来了。
 * 故总量与细分并存，代价是多存一份 —— 细分是稀疏的（一个群通常只有一个账号在收），
 * 实测远小于把键拆开的写法。
 */
export interface PeerDay {
  /** 会话标识，`group:123` / `private:456` / `guild:1/2` */
  peer: string
  /** 会话显示名，取群名或昵称，缺省为标识 */
  name: string
  /** 会话类型 */
  scene: "group" | "private" | "guild"
  /** 收到的（全部账号之和） */
  recv: Tally
  /** 发出的（全部账号之和） */
  sent: Tally
  /** 按账号细分，键为 `platform:accountId`；旧文档或未记账号时可缺 */
  by?: Record<string, Pair>
}

/**
 * 某一小时的收发计数
 *
 * **不按会话细分。** 「当日」与「1 日」两档要按小时画趋势，而趋势图问的是总量；
 * 若这里也按会话存，一天就是 `24 × 会话数` 个桶，长期驻留内存的代价陡增，
 * 换来的是一张没人看的「某群某小时」。会话维度由 `PeerDay` 那一层给。
 */
export interface HourSlot {
  /** 全部账号之和 */
  recv: Tally
  /** 全部账号之和 */
  sent: Tally
  /** 按账号细分，键为 `platform:accountId` */
  by?: Record<string, Pair>
}

/** 一天的全部计数 */
export interface DayBucket {
  /** 本地日期，`YYYY-MM-DD` */
  day: string
  /** 该天各会话的计数，键为 `peer` */
  peers: Record<string, PeerDay>
  /**
   * 该天各小时的计数，键为 `00`..`23`
   *
   * 只有近 `HOUR_KEEP_DAYS` 天有；更早的天在裁剪时被摘掉，只留 `peers` 那份天汇总。
   * 故按小时看只能看近处 —— 而「当日」「1 日」两档本就只问近处。
   */
  hours?: Record<string, HourSlot>
}

/** 一个账号的身份，供界面把 `platform:accountId` 显示成人能读的东西 */
export interface AccountRef {
  /** 平台标识，如 `qq` */
  platform: string
  /** 适配器 id，如 `onebot11`；收侧事件给不出时为空串 */
  adapter: string
  /** 账号 id */
  account: string
}

/** 落盘与接口返回的文档结构 */
export interface StatsDoc {
  /**
   * 文档格式版本
   *
   * 2 起带小时桶与账号维度。**读到 1 一律作废重来**（`parseStatsDoc` 返回 undefined）：
   * 旧文档没有账号信息，迁移过来只能把全部历史记到一个「未知账号」名下，
   * 而那会让按账号筛选的结果长期是错的 —— 从空开始更诚实。
   */
  version: 2
  /** 按天分桶，键为 `YYYY-MM-DD` */
  days: Record<string, DayBucket>
  /** 见过的账号，键为 `platform:accountId` */
  accounts?: Record<string, AccountRef>
}

/** 保留多少天：界面最长看 30 天，多留一点让「自定义范围」还能往前翻一截 */
export const KEEP_DAYS = 40

/**
 * 小时桶保留多少天
 *
 * 取 7 天：按小时看的只有「当日」与「1 日」两档，7 天已给足回看余量。
 * 全部 40 天都存小时的话桶数是 24 倍，而多出来的那些一次都不会被读到。
 */
export const HOUR_KEEP_DAYS = 7

/**
 * 求某个时刻的本地日期键
 *
 * 手工取年月日而非 `toISOString().slice(0, 10)`：后者按 UTC 切，东八区凌晨 8 点前的消息
 * 会被记到前一天，表现为「今天明明聊过，统计里是 0」。
 * @param at 毫秒时间戳
 * @returns `YYYY-MM-DD`
 */
export function dayKey(at: number): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 造一份空计数
 * @returns 三项皆 0 的计数
 */
export function emptyTally(): Tally {
  return { messages: 0, images: 0, stickers: 0 }
}

/**
 * 把 b 加进 a
 * @param a 累加目标，就地修改
 * @param b 增量
 */
function addTally(a: Tally, b: Tally): void {
  a.messages += b.messages
  a.images += b.images
  a.stickers += b.stickers
}

/** 一次收发的入账内容 */
export interface Entry {
  /** 发生时刻，毫秒时间戳 */
  at: number
  /** 会话标识 */
  peer: string
  /** 会话显示名 */
  name: string
  /** 会话类型 */
  scene: PeerDay["scene"]
  /** 方向 */
  dir: "recv" | "sent"
  /** 本次的分项计数 */
  tally: Tally
  /**
   * 经手这一条的账号；取不到时可缺
   *
   * 缺了仍照常入账，只是这一条不出现在任何「按账号筛选」的结果里 —— 丢掉整条更糟：
   * 总量会因此少掉一截，而使用者无从知道少了什么。
   */
  account?: AccountRef
}

/**
 * 求某个时刻的小时键
 * @param at 毫秒时间戳
 * @returns `00`..`23`
 */
export function hourKey(at: number): string {
  return `${new Date(at).getHours()}`.padStart(2, "0")
}

/**
 * 拼一个账号的键
 *
 * 用 `platform:account` 而非把适配器 id 也拼进去：同一个账号换适配器接入（NapCat 换成
 * Lagrange）时，使用者眼里仍是同一个号，历史不该因此断成两截。适配器 id 只作显示用，
 * 存在 `AccountRef.adapter` 里。
 * @param ref 账号身份
 * @returns 键
 */
export function accountKey(ref: AccountRef): string {
  return `${ref.platform}:${ref.account}`
}

/**
 * 造一对空的收发计数
 * @returns 两侧皆 0
 */
function emptyPair(): Pair {
  return { recv: emptyTally(), sent: emptyTally() }
}

/**
 * 把一次计数加进「按账号细分」那一层
 *
 * `by` 惰性建立：多数部署只有一个账号，恒建一个只含一项的对象会让文档凭空大一圈。
 * @param holder 宿主（会话日或小时槽）
 * @param key 账号键
 * @param dir 方向
 * @param tally 增量
 */
function addToBy(holder: { by?: Record<string, Pair> }, key: string, dir: "recv" | "sent", tally: Tally): void {
  holder.by ??= {}
  const pair = (holder.by[key] ??= emptyPair())
  addTally(dir === "recv" ? pair.recv : pair.sent, tally)
}

/**
 * 按 `rename` 改写一个宿主的 `by` 键，同键相遇则两侧计数相加
 *
 * 就地改：调用方持有的正是文档里那个对象。
 * @param holder 宿主（会话日或小时槽）
 * @param rename 旧键到新键
 */
function mergeBy(holder: { by?: Record<string, Pair> }, rename: ReadonlyMap<string, string>): void {
  const by = holder.by
  if (by === undefined) return
  for (const [oldKey, newKey] of rename) {
    const from = by[oldKey]
    if (from === undefined) continue
    delete by[oldKey]
    const into = (by[newKey] ??= emptyPair())
    addTally(into.recv, from.recv)
    addTally(into.sent, from.sent)
  }
}

/**
 * 按天、会话与小时分桶的计数器
 *
 * 全量驻留内存：一天的桶是「会话数 × 6 个整数」加「24 × 6」，40 天下来即便上千个会话
 * 也只有几百 KB，换来的是查询无须读盘、也无须为时间范围建索引。
 */
export class StatsBuckets {
  /** 按天分桶 */
  #days = new Map<string, DayBucket>()

  /** 见过的账号，键为 `platform:account` */
  #accounts = new Map<string, AccountRef>()

  /** 自上次落盘以来是否有变化，省掉无消息时的空写 */
  #dirty = false

  /**
   * @param doc 已有的文档，用于从磁盘恢复；不给则从空开始
   */
  constructor(doc?: StatsDoc) {
    if (doc !== undefined) {
      for (const [day, bucket] of Object.entries(doc.days)) this.#days.set(day, bucket)
      for (const [key, ref] of Object.entries(doc.accounts ?? {})) this.#accounts.set(key, ref)
    }
  }

  /** 自上次 `snapshot()` 起是否有新数据 */
  get dirty(): boolean {
    return this.#dirty
  }

  /**
   * 入账一次收发
   *
   * 同一条数据写进三处：会话日（总量）、会话日的账号细分、当天的小时槽。三处各答一类问题
   * （哪个群最多 / 哪个号在收 / 一天里什么时候忙），任一处缺了那个问题就答不出来。
   * @param entry 本次内容
   */
  add(entry: Entry): void {
    const day = dayKey(entry.at)
    let bucket = this.#days.get(day)
    if (bucket === undefined) {
      bucket = { day, peers: {} }
      this.#days.set(day, bucket)
    }
    let peer = bucket.peers[entry.peer]
    if (peer === undefined) {
      peer = { peer: entry.peer, name: entry.name, scene: entry.scene, recv: emptyTally(), sent: emptyTally() }
      bucket.peers[entry.peer] = peer
    }
    // 名字每次都更新：群改名之后，统计里该显示新名字，而首次入账时那个名字可能还是空的
    if (entry.name !== "" && entry.name !== entry.peer) peer.name = entry.name
    addTally(entry.dir === "recv" ? peer.recv : peer.sent, entry.tally)

    // 小时槽：与会话无关，只按时刻归集
    bucket.hours ??= {}
    const slot = (bucket.hours[hourKey(entry.at)] ??= { recv: emptyTally(), sent: emptyTally() })
    addTally(entry.dir === "recv" ? slot.recv : slot.sent, entry.tally)

    if (entry.account !== undefined) {
      const key = accountKey(entry.account)
      // 身份每次覆盖：适配器换了、或首次入账时 adapter 还取不到，后来那一份更准
      this.#accounts.set(key, entry.account)
      addToBy(peer, key, entry.dir, entry.tally)
      addToBy(slot, key, entry.dir, entry.tally)
    }

    this.#dirty = true
  }

  /**
   * 把账号键从**记录 id** 改写成**平台 id**，并合并两者已有的数据
   *
   * 修一个曾经写错的键：发侧一度用 `MessageSentInfo.accountId`（内核生成的记录 uuid）作键，
   * 而收侧用的是 `selfId`（平台 id），于是同一个号在界面上成了两个账号 —— 收到的全在
   * QQ 号下，发出的全在一串 uuid 下。采集侧已改正，但**盘上那份旧数据不会自己好**：
   * 天汇总留 40 天，那个幽灵账号会一直挂着。
   *
   * 合并而非丢弃：uuid 那侧的计数是真实发生过的发送量，丢掉会让「发出多少条」凭空少一截。
   *
   * 改写三处，与 `add` 写入的三处一一对应：账号身份表、各会话日的 `by`、各小时槽的 `by`。
   * 漏掉任一处的表现都是「筛这个账号时某一类数字对不上」，而不会报错。
   * @param resolve 把记录 id 换成平台 id；换不到时返回 undefined
   * @returns 改写掉的键数
   */
  remapAccounts(resolve: (account: string) => string | undefined): number {
    /** 旧键到新键，只含真正要改的 */
    const rename = new Map<string, string>()
    for (const [key, ref] of this.#accounts) {
      const selfId = resolve(ref.account)
      if (selfId === undefined || selfId === ref.account) continue
      rename.set(key, accountKey({ ...ref, account: selfId }))
    }
    if (rename.size === 0) return 0

    for (const [oldKey, newKey] of rename) {
      const ref = this.#accounts.get(oldKey)
      this.#accounts.delete(oldKey)
      // 已有同名的那份更可信（它来自收侧，`adapter` 可能是空串），只补 adapter 这一项
      const existing = this.#accounts.get(newKey)
      if (existing === undefined) {
        if (ref !== undefined) this.#accounts.set(newKey, { ...ref, account: newKey.slice(ref.platform.length + 1) })
      } else if (existing.adapter === "" && ref !== undefined && ref.adapter !== "") {
        this.#accounts.set(newKey, { ...existing, adapter: ref.adapter })
      }
    }

    for (const bucket of this.#days.values()) {
      for (const peer of Object.values(bucket.peers)) mergeBy(peer, rename)
      for (const slot of Object.values(bucket.hours ?? {})) mergeBy(slot, rename)
    }

    this.#dirty = true
    return rename.size
  }

  /**
   * 丢掉超出保留期的天
   *
   * 以「今天」为基准按日期字符串比较（`YYYY-MM-DD` 的字典序即时间序），不算时间差 ——
   * 后者要处理夏令时与闰秒，而这里只需要「太旧就删」。
   * @param now 当前时刻，毫秒时间戳
   * @returns 删掉的天数
   */
  prune(now: number): number {
    const floor = dayKey(now - (KEEP_DAYS - 1) * 86_400_000)
    const hourFloor = dayKey(now - (HOUR_KEEP_DAYS - 1) * 86_400_000)
    let dropped = 0
    for (const day of [...this.#days.keys()]) {
      if (day < floor) {
        this.#days.delete(day)
        dropped += 1
        continue
      }
      /*
       * 过了小时保留期就摘掉 `hours`，天汇总留着
       *
       * 这是「近 7 天按小时、更早只按天」那条约定的落实处。不摘的话文档会一直长：
       * 小时桶是天汇总的 24 倍，而 7 天以外没有任何一档界面会去读它。
       */
      const bucket = this.#days.get(day)
      if (day < hourFloor && bucket?.hours !== undefined) {
        delete bucket.hours
        this.#dirty = true
      }
    }
    if (dropped > 0) this.#dirty = true
    return dropped
  }

  /**
   * 取一份可落盘、可直接送给前端的快照
   *
   * 顺带清掉 dirty 标记：调用方拿到快照就意味着这一份已被处理。
   * @returns 文档
   */
  snapshot(): StatsDoc {
    this.#dirty = false
    const days: Record<string, DayBucket> = {}
    for (const day of [...this.#days.keys()].sort()) {
      const bucket = this.#days.get(day)
      if (bucket !== undefined) days[day] = bucket
    }
    const accounts: Record<string, AccountRef> = {}
    for (const key of [...this.#accounts.keys()].sort()) {
      const ref = this.#accounts.get(key)
      if (ref !== undefined) accounts[key] = ref
    }
    return { version: 2, days, accounts }
  }
}

/**
 * 校验一份读回来的文档
 *
 * 磁盘上那份按不可信输入对待：它可能被手工改过，也可能是将来某个版本写下的。逐层校验而非
 * 只看 `version`：结构对不上时一个字段错位就会让界面画出天文数字，而那比「统计从零开始」难查得多。
 * @param raw 已解析的 JSON
 * @returns 文档；不可用时 undefined
 */
export function parseStatsDoc(raw: unknown): StatsDoc | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as { version?: unknown; days?: unknown; accounts?: unknown }
  /*
   * 只认 2，读到 1 一律作废重来
   *
   * 版本 1 没有账号维度，迁过来只能把全部历史挂到一个「未知账号」名下 —— 此后按账号
   * 筛选时那些数据要么恒被算进每个账号，要么恒被排除，两种都是长期错着的。
   * 从空开始至少是诚实的，且统计本就在持续采集。
   */
  if (record.version !== 2) return undefined
  if (typeof record.days !== "object" || record.days === null) return undefined
  const days: Record<string, DayBucket> = {}
  for (const [day, value] of Object.entries(record.days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    if (typeof value !== "object" || value === null) continue
    const peersRaw = (value as { peers?: unknown }).peers
    if (typeof peersRaw !== "object" || peersRaw === null) continue
    const peers: Record<string, PeerDay> = {}
    for (const [key, item] of Object.entries(peersRaw as Record<string, unknown>)) {
      const peer = parsePeerDay(key, item)
      if (peer !== undefined) peers[key] = peer
    }
    const bucket: DayBucket = { day, peers }
    const hours = parseHours((value as { hours?: unknown }).hours)
    if (hours !== undefined) bucket.hours = hours
    days[day] = bucket
  }
  const accounts = parseAccounts(record.accounts)
  return accounts === undefined ? { version: 2, days } : { version: 2, days, accounts }
}

/**
 * 校验小时桶
 *
 * 键须是 `00`..`23`：越界的键会让「一天 24 格」的趋势图多画出一格，而那一格无处安放。
 * @param raw 记录
 * @returns 小时桶；一格都没有时 undefined（不留空对象，省得文档里满是 `"hours": {}`）
 */
function parseHours(raw: unknown): Record<string, HourSlot> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const out: Record<string, HourSlot> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^([01]\d|2[0-3])$/.test(key)) continue
    if (typeof value !== "object" || value === null) continue
    const record = value as { recv?: unknown; sent?: unknown; by?: unknown }
    const slot: HourSlot = { recv: parseTally(record.recv), sent: parseTally(record.sent) }
    const by = parseBy(record.by)
    if (by !== undefined) slot.by = by
    out[key] = slot
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 校验按账号细分的那一层
 * @param raw 记录
 * @returns 细分；一项都没有时 undefined
 */
function parseBy(raw: unknown): Record<string, Pair> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const out: Record<string, Pair> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "") continue
    const record = typeof value === "object" && value !== null ? (value as { recv?: unknown; sent?: unknown }) : {}
    out[key] = { recv: parseTally(record.recv), sent: parseTally(record.sent) }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 校验账号表
 * @param raw 记录
 * @returns 账号表；一项都没有时 undefined
 */
function parseAccounts(raw: unknown): Record<string, AccountRef> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const out: Record<string, AccountRef> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "" || typeof value !== "object" || value === null) continue
    const record = value as { platform?: unknown; adapter?: unknown; account?: unknown }
    const platform = typeof record.platform === "string" ? record.platform : ""
    const account = typeof record.account === "string" ? record.account : ""
    // 平台与账号缺一个这条就无从显示，丢掉；适配器可缺（收侧事件给不出）
    if (platform === "" || account === "") continue
    out[key] = { platform, account, adapter: typeof record.adapter === "string" ? record.adapter : "" }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 校验一个会话日计数
 * @param key 会话标识
 * @param raw 记录
 * @returns 会话日计数；不可用时 undefined
 */
function parsePeerDay(key: string, raw: unknown): PeerDay | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as { name?: unknown; scene?: unknown; recv?: unknown; sent?: unknown; by?: unknown }
  const scene = record.scene
  if (scene !== "group" && scene !== "private" && scene !== "guild") return undefined
  const out: PeerDay = {
    peer: key,
    name: typeof record.name === "string" && record.name !== "" ? record.name : key,
    scene,
    recv: parseTally(record.recv),
    sent: parseTally(record.sent)
  }
  const by = parseBy(record.by)
  if (by !== undefined) out.by = by
  return out
}

/**
 * 校验一份计数，任一项不是非负有限数即归零
 *
 * 归零而非丢弃整条：一个被改坏的数字不该让那个会话整体消失 —— 消失更难被发现。
 * @param raw 记录
 * @returns 计数
 */
function parseTally(raw: unknown): Tally {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  /**
   * 取一项非负整数
   * @param key 字段名
   * @returns 数值，不合法时 0
   */
  const num = (key: string): number => {
    const value = record[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  }
  return { messages: num("messages"), images: num("images"), stickers: num("stickers") }
}

/** 聚合结果里的一个会话 */
export interface PeerTotal {
  /** 会话标识 */
  peer: string
  /** 显示名 */
  name: string
  /** 会话类型 */
  scene: PeerDay["scene"]
  /** 区间内收到的 */
  recv: Tally
  /** 区间内发出的 */
  sent: Tally
}

/** 一个时间区间的聚合结果 */
export interface Aggregate {
  /** 起始日期，含 */
  from: string
  /** 结束日期，含 */
  to: string
  /**
   * 趋势序列，按时间升序，区间内无数据的格子也在其中（值为 0）
   *
   * `label` 是那一格的**横轴标签**，刻意做短：按天时是 `YYYY-MM-DD`，按小时时是 `HH`（当日）
   * 或 `MM-DD HH`（跨天的 24 小时窗）。图只管画 `label`，不必知道自己是哪种粒度。
   *
   * `at` 是那一格的**完整身份**：按天时 `YYYY-MM-DD`，按小时时 `YYYY-MM-DD HH`。
   * 与 `label` 分开而非共用一个值 —— 两者的取舍相反：横轴要短到不重叠（故按小时时省掉日期，
   * 当日那一档甚至只剩 `HH`），而 tooltip 要读一眼就知道是哪天几点，`13` 在「近 7 天」
   * 那个视图里根本读不出是哪天。格式化成人话的活儿留给界面，此处只给不失真的键。
   */
  series: readonly { label: string; at: string; recv: Tally; sent: Tally }[]
  /** 序列的粒度，界面据此写副标题（「按天」/「按小时」） */
  unit: "day" | "hour"
  /** 各会话合计，按「收发总条数」降序 */
  peers: readonly PeerTotal[]
  /** 区间总计 */
  total: { recv: Tally; sent: Tally }
}

/**
 * 取一个宿主（会话日或小时槽）上指定账号的那一份计数
 *
 * `account` 为 undefined 时给总量。**筛某个账号而该宿主没有 `by` 时给 0 而不是给总量** ——
 * 后者会让「只看账号 A」在旧数据上显示成全部账号之和，那比显示 0 更糟：使用者以为筛选生效了。
 * @param holder 宿主
 * @param dir 方向
 * @param account 账号键；不筛时 undefined
 * @returns 计数（只读用，勿改）
 */
function tallyOf(
  holder: { recv: Tally; sent: Tally; by?: Record<string, Pair> },
  dir: "recv" | "sent",
  account: string | undefined
): Tally {
  if (account === undefined) return dir === "recv" ? holder.recv : holder.sent
  const pair = holder.by?.[account]
  if (pair === undefined) return emptyTally()
  return dir === "recv" ? pair.recv : pair.sent
}

/**
 * 把日期键往后推若干天
 * @param day `YYYY-MM-DD`
 * @param delta 天数，可为负
 * @returns `YYYY-MM-DD`
 */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number)
  // 按本地时间构造再取回，让 Date 自己处理月末与闰年
  const at = new Date(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + delta)
  return dayKey(at.getTime())
}

/**
 * 累加会话维度，两种聚合共用
 *
 * 会话表恒按天桶算，**与趋势的粒度无关**：按小时看时「哪个群最多」问的仍是整个窗口内的合计，
 * 而小时槽不带会话维度（见 `HourSlot`）。
 * @param peers 累加目标
 * @param bucket 天桶
 * @param account 账号键；不筛时 undefined
 */
function addPeers(peers: Map<string, PeerTotal>, bucket: DayBucket, account: string | undefined): void {
  for (const item of Object.values(bucket.peers)) {
    /*
     * 筛账号时，这个账号在这个会话里没出现过就整条跳过
     *
     * 不跳过的话会话仍会进表，只是六个数字全是 0 —— 界面上是一行「甲群 0 0 0」，
     * 读起来像「这个群今天没人说话」，而实情是「这个号不在这个群里」。两件事差得很远。
     * 判据取 `by` 里有没有这一项，而不是「算出来是不是 0」：一个真的收发都为 0 的
     * 会话记录（理论上不会有，但文档是可被手改的）仍该按它自己的样子显示。
     */
    if (account !== undefined && item.by?.[account] === undefined) continue
    let entry = peers.get(item.peer)
    if (entry === undefined) {
      entry = { peer: item.peer, name: item.name, scene: item.scene, recv: emptyTally(), sent: emptyTally() }
      peers.set(item.peer, entry)
    }
    // 后出现的天带的名字更新，用它覆盖：群改过名时该显示现在的名字
    if (item.name !== "" && item.name !== item.peer) entry.name = item.name
    addTally(entry.recv, tallyOf(item, "recv", account))
    addTally(entry.sent, tallyOf(item, "sent", account))
  }
}

/**
 * 把会话表排好序
 * @param peers 会话表
 * @returns 按收发总条数降序的数组
 */
function sortPeers(peers: Map<string, PeerTotal>): PeerTotal[] {
  return [...peers.values()].sort(
    (a, b) => b.recv.messages + b.sent.messages - (a.recv.messages + a.sent.messages)
  )
}

/**
 * 在一个区间上按天聚合
 *
 * 区间内没有数据的天**也要出现在 series 里**，值为 0：柱形图缺了那一根会让人以为那天不存在，
 * 而「那天一条消息都没有」本身就是要看的信息。
 * @param doc 文档
 * @param from 起始日期，含
 * @param to 结束日期，含
 * @param account 只看这个账号（`platform:account`）；不给则全部账号
 * @returns 聚合结果
 */
export function aggregate(doc: StatsDoc, from: string, to: string, account?: string): Aggregate {
  const lo = from <= to ? from : to
  const hi = from <= to ? to : from
  const series: { label: string; at: string; recv: Tally; sent: Tally }[] = []
  const peers = new Map<string, PeerTotal>()
  const total = { recv: emptyTally(), sent: emptyTally() }

  for (let day = lo; day <= hi; day = shiftDay(day, 1)) {
    const recv = emptyTally()
    const sent = emptyTally()
    const bucket = doc.days[day]
    if (bucket !== undefined) {
      for (const item of Object.values(bucket.peers)) {
        addTally(recv, tallyOf(item, "recv", account))
        addTally(sent, tallyOf(item, "sent", account))
      }
      addPeers(peers, bucket, account)
    }
    addTally(total.recv, recv)
    addTally(total.sent, sent)
    // 按天时两者同值；仍各给一份，免得界面去猜「这一格的 label 能不能当身份用」
    series.push({ label: day, at: day, recv, sent })
    // 防串：区间写反或跨度极大时不至于把内存转光
    if (series.length > 400) break
  }

  return { from: lo, to: hi, series, unit: "day", peers: sortPeers(peers), total }
}

/**
 * 在「最近 N 小时」上按小时聚合
 *
 * 两处口径由调用方用 `hours` 表达，本函数只管「从此刻往前数 N 格」：
 * - 当日 = 当天 00:00 到此刻 → `hours` 传「此刻的小时数 + 1」
 * - 1 日 = 此刻往前 24 小时 → `hours` 传 24
 *
 * **末格是当前那个不完整的小时**，照样画出来：它正在长，而使用者最想看的往往是「刚才」。
 *
 * 缺小时桶的天给 0 而不是回退到天汇总：天汇总摊到 24 格是编造出来的分布，
 * 而「7 天以前看不到小时分布」是这份存储的既定取舍（见 `HOUR_KEEP_DAYS`）。
 * @param doc 文档
 * @param now 此刻，毫秒时间戳
 * @param hours 往前数几格，至少 1
 * @param account 只看这个账号；不给则全部账号
 * @returns 聚合结果，`unit` 为 `hour`
 */
export function aggregateHours(doc: StatsDoc, now: number, hours: number, account?: string): Aggregate {
  const span = Math.max(1, Math.min(Math.floor(hours), 24 * HOUR_KEEP_DAYS))
  const series: { label: string; at: string; recv: Tally; sent: Tally }[] = []
  const total = { recv: emptyTally(), sent: emptyTally() }
  const peers = new Map<string, PeerTotal>()
  const days = new Set<string>()

  // 从最早那格数到当前格，故 i 从 span-1 递减到 0
  for (let i = span - 1; i >= 0; i -= 1) {
    const at = now - i * 3_600_000
    const day = dayKey(at)
    const hour = hourKey(at)
    days.add(day)
    const slot = doc.days[day]?.hours?.[hour]
    const recv = slot === undefined ? emptyTally() : { ...tallyOf(slot, "recv", account) }
    const sent = slot === undefined ? emptyTally() : { ...tallyOf(slot, "sent", account) }
    addTally(total.recv, recv)
    addTally(total.sent, sent)
    /*
     * 跨天的窗口在标签里带上日期
     *
     * 「1 日」这一档从昨天某时刻数到今天此刻，只写 `HH` 的话横轴会出现两个 `09` ——
     * 读不出哪个是昨天。当日那一档不跨天，故只写 `HH`，省得每格都重复同一个日期。
     */
    const sameDay = day === dayKey(now)
    // `at` 恒带日期，与 `label` 省不省日期无关 —— tooltip 要的是「哪天几点」
    series.push({ label: sameDay ? hour : `${day.slice(5)} ${hour}`, at: `${day} ${hour}`, recv, sent })
  }

  // 会话表按窗口覆盖到的天算：小时槽不带会话维度，这已是能给出的最细口径
  for (const day of days) {
    const bucket = doc.days[day]
    if (bucket !== undefined) addPeers(peers, bucket, account)
  }

  const first = series[0]?.label ?? ""
  const last = series[series.length - 1]?.label ?? ""
  return { from: first, to: last, series, unit: "hour", peers: sortPeers(peers), total }
}
