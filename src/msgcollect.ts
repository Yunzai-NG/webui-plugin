/**
 * 模块职责：消息统计的采集与落盘 —— 订阅内核收发事件、把事件折成计数、定时与退出时写文件
 * 依赖方向：依赖 node 内置模块、类型包与本目录的 msgstats；纯逻辑都在 msgstats，此处只管接线与 IO
 * 生命周期：随 webui 的 `setup()` 起，返回的 Disposer 停掉定时器；事件订阅由内核在卸载时归还
 * 注意事项：**采集器归 webui 自己，不下放给 `CustomPageContext`。** 统计要监听 `message` 与
 *          `message/sent`，而把事件订阅开放给任意装了 `webadapter/` 的插件，等于把全部聊天内容
 *          交给它们 —— 业务插件本来就能在自己的内核插件里 `ctx.on`，对它们毫无必要。故 webui
 *          以宿主身份用完整 `ctx` 采集，页面仍走同一份清单与同一道桥。
 *
 *          **收侧埋在 `message` 事件而非命令回调**：内核在命令路由之后触发它（注释即如此写），
 *          故没匹配上任何命令的消息也会计入 —— 那本来就该计入，「收到多少条」与「有没有人用命令」
 *          是两件事。
 *
 *          **发侧埋在 `message/sent` 而非 `e.reply()`**：`ctx.render()` 之后的发送与定时任务的
 *          主动推送都不经 `reply()`，埋在那儿会漏掉，且漏得毫无迹象。
 *
 *          **发出去的图片分不出表情包**，理由与限度见 msgstats.ts 文件头。
 *
 *          落盘做节流而不是每条消息都写：一个活跃群一分钟能来几十条，每条都写整份文档会把
 *          磁盘写成瓶颈。`app/stopping` 时补一次，故正常退出不丢；进程被 kill -9 时最多丢
 *          一个节流窗口的量，对统计而言可接受。
 */
import { readFile, mkdir, writeFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Disposer, MessageEvent, MessageSentInfo, Segment } from "@yunzai-ng/types"
import { StatsBuckets, dayKey, emptyTally, parseStatsDoc, type Entry, type PeerDay, type Tally } from "./msgstats.js"

/** 统计文件名，落在 webui 的数据目录下 */
export const STATS_FILE = "msgstats.json"

/** 落盘节流间隔毫秒：活跃时最多每半分钟写一次 */
const FLUSH_MS = 30_000

/** QQ 表情图的 `ImageSegment.subType`，见 types 的 segment.ts */
const STICKER_SUBTYPE = 1

/**
 * 把收到的消息段折成分项计数
 *
 * 表情包取两处之和：QQ 原生表情是 `face` 段，而「表情包」在 QQ 里多半是 `subType === 1` 的
 * 图片。两者在使用者眼里是一类东西，故并作一项；`images` 仍含表情图，因为「发/收了多少张图」
 * 问的是流量意义上的图片数。
 * @param segments 消息段
 * @returns 分项计数，`messages` 恒为 1
 */
export function tallyOfSegments(segments: readonly Segment[]): Tally {
  const tally = emptyTally()
  tally.messages = 1
  for (const seg of segments) {
    if (seg.type === "image") {
      tally.images += 1
      if (seg.subType === STICKER_SUBTYPE) tally.stickers += 1
    } else if (seg.type === "face") {
      tally.stickers += 1
    }
  }
  return tally
}

/**
 * 把发送结果的 `kinds` 折成分项计数
 *
 * `kinds` 是按段 `type` 聚合的计数，故拿不到 `image.subType` —— 发送侧的 `stickers` 只能计
 * `face`，表情图混在 `images` 里数不出来。这不是偷懒：那一层信息在内核聚合时就已经没了，
 * 要补得改内核的 `MessageSentInfo`。界面须就此说明，见 msgstats.ts 文件头。
 * @param kinds 段类型到出现次数
 * @returns 分项计数，`messages` 恒为 1
 */
export function tallyOfKinds(kinds: Readonly<Record<string, number>>): Tally {
  const tally = emptyTally()
  tally.messages = 1
  /**
   * 取一项非负整数，适配器给出的数字同样不可信
   * @param key 段类型
   * @returns 次数
   */
  const num = (key: string): number => {
    const value = kinds[key]
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
  tally.images = num("image")
  tally.stickers = num("face")
  return tally
}

/** 一次收发所属的会话 */
export interface Peer {
  /** 会话标识 */
  peer: string
  /** 显示名 */
  name: string
  /** 会话类型 */
  scene: PeerDay["scene"]
}

/**
 * 求收到的消息属于哪个会话
 *
 * 群消息按群归集而非按发言人：使用者要看的是「各群收发统计」。私聊按对方 uid 归集。
 * @param e 消息事件
 * @returns 会话
 */
export function peerOfEvent(e: MessageEvent): Peer {
  if (e.scene === "group" && e.group !== undefined) {
    return { peer: `group:${e.group.gid}`, name: e.group.name ?? `群 ${e.group.gid}`, scene: "group" }
  }
  if (e.scene === "guild" && e.channel !== undefined) {
    return {
      peer: `guild:${e.channel.guildId}/${e.channel.channelId}`,
      name: e.channel.name ?? `子频道 ${e.channel.channelId}`,
      scene: "guild"
    }
  }
  const uid = e.sender.uid
  return { peer: `private:${uid}`, name: e.sender.name ?? `用户 ${uid}`, scene: "private" }
}

/**
 * 求发出的消息属于哪个会话
 *
 * 标识与 `peerOfEvent` 必须拼得一模一样，否则同一个群的收与发会落成两个会话，界面上表现为
 * 「每个群都只有一半数据」。发送侧没有群名可用，故名字留给收侧补 —— `StatsBuckets.add`
 * 在名字等于标识时不覆盖已有的名字，正是为这一条。
 * @param target 发送目标
 * @returns 会话
 */
export function peerOfTarget(target: MessageSentInfo["target"]): Peer {
  if (target.scene === "group") return { peer: `group:${target.gid}`, name: `群 ${target.gid}`, scene: "group" }
  if (target.scene === "guild") {
    return {
      peer: `guild:${target.guildId}/${target.channelId}`,
      name: `子频道 ${target.channelId}`,
      scene: "guild"
    }
  }
  return { peer: `private:${target.uid}`, name: `用户 ${target.uid}`, scene: "private" }
}

/** 采集器要的上下文，只列真正用到的几项 */
export interface CollectHost {
  /** 本插件数据目录 */
  readonly dataDir: string
  /** 日志器 */
  readonly logger: { warn(msg: string): void; debug(msg: string): void }
  /**
   * 订阅内核事件
   * @param event 事件名
   * @param handler 处理函数
   * @returns 注销句柄
   */
  on(event: "message" | "message/sent" | "app/stopping", handler: (...args: never[]) => unknown): Disposer
  /**
   * 把账号**记录 id** 换成**平台 id**
   *
   * 这一项是「同一个号不要裂成两个」的关键，见下方两个处理函数处的长注释。
   * 缺省不给时退回记录 id —— 那时统计仍然对，只是账号筛选里会多出一个 uuid 形态的条目。
   * @param accountId 账号记录 id
   * @returns 平台 id；账号不存在或尚未回填时 undefined
   */
  selfIdOf?(accountId: string): string | undefined
}

/** 采集器句柄 */
export interface Collector {
  /** 取当前统计，供接口直接送出 */
  read(): ReturnType<StatsBuckets["snapshot"]>
  /** 停掉定时器并落盘 */
  stop(): Promise<void>
}

/**
 * 起一个采集器
 *
 * 读盘失败不算错误：文件不存在就是首次运行，内容坏了则从空开始 —— 让统计从零开始远好过
 * 让 webui 因为一份统计文件打不开。
 * @param host 上下文
 * @returns 采集器句柄
 */
export async function startCollector(host: CollectHost): Promise<Collector> {
  const file = join(host.dataDir, STATS_FILE)
  let buckets: StatsBuckets
  try {
    const doc = parseStatsDoc(JSON.parse(await readFile(file, "utf8")))
    buckets = new StatsBuckets(doc)
    if (doc === undefined) host.logger.warn(`消息统计文件格式不符，已从空开始：${file}`)
  } catch {
    buckets = new StatsBuckets()
  }
  buckets.prune(Date.now())

  /*
   * 顺手把旧数据里记录 id 形态的账号键并回平台 id
   *
   * 采集侧改正之后新数据就是对的，但盘上那份不会自己好 —— 天汇总留 40 天，那个 uuid 形态的
   * 幽灵账号会一直挂在筛选框里。启动时做一次；`selfIdOf` 没给、或那些记录已被删掉时
   * 什么都不做。
   */
  if (host.selfIdOf !== undefined) {
    const resolve = host.selfIdOf.bind(host)
    const fixed = buckets.remapAccounts(resolve)
    if (fixed > 0) host.logger.warn(`消息统计：${fixed} 个账号键由记录 id 并回平台 id，历史已合并`)
  }

  /**
   * 入账一次收发，异常吞掉只记日志
   *
   * 统计出错绝不能影响消息处理：这两个处理函数跑在内核的事件管道里，抛出去会变成一条
   * `pipeline/error`，而使用者看到的是「机器人偶发报错」，与统计八竿子打不着。
   * @param entry 入账内容
   */
  const take = (entry: Entry): void => {
    try {
      buckets.add(entry)
    } catch (err) {
      host.logger.debug(`消息统计入账失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /*
   * 两侧的账号键必须是**同一个东西**，否则一个号会裂成两个
   *
   * 这里曾经错过一次，症状是界面上出现两个账号：收到的全记在 QQ 号下，发出的全记在一串
   * uuid 下。根因是两个事件描述「同一个账号」用的是不同的标识 —— 收侧的事件给
   * `selfId`（平台 id，如 QQ 号），而发侧的 `MessageSentInfo` 给 `accountId`
   * （**内核生成的记录 uuid**，见 `AccountRecord.id`：同一个号可以有两份不同配置，
   * 故记录 id 与平台 id 本就不是一回事）。
   *
   * 统一取**平台 id**：它是使用者认得的那个号，且换适配器接入（NapCat 换 Lagrange）
   * 时不变；记录 id 则会随「删掉重配一次」而变，拿它作键会让同一个号的历史断成两截。
   * 故发侧先把记录 id 换成平台 id（`selfIdOf`，问的是内核的账号表）。换不到时退回记录 id：
   * 那时至少不丢数据，而能发出消息的号必然连上过，`selfId` 早已回填，这条路实际走不到。
   *
   * `adapter` 仍只有发侧给得出（收侧事件不带适配器 id），故收侧留空串，由账号表里后写的
   * 那一份补上。
   */
  const offRecv = host.on("message", ((e: MessageEvent) => {
    const peer = peerOfEvent(e)
    take({
      at: e.time,
      ...peer,
      dir: "recv",
      tally: tallyOfSegments(e.message),
      account: { platform: e.platform, adapter: "", account: e.selfId }
    })
  }) as (...args: never[]) => unknown)

  const offSent = host.on("message/sent", ((info: MessageSentInfo) => {
    // 发失败的不计入：使用者问「发出去多少条」，指的是真的发出去的那些
    if (!info.ok) return
    const peer = peerOfTarget(info.target)
    take({
      at: Date.now(),
      ...peer,
      dir: "sent",
      tally: tallyOfKinds(info.kinds),
      account: {
        platform: info.platform,
        adapter: info.adapterId,
        account: host.selfIdOf?.(info.accountId) ?? info.accountId
      }
    })
  }) as (...args: never[]) => unknown)

  /**
   * 写一次文件
   *
   * 先写临时文件再改名：整份文档几十到几百 KB，直接覆盖时若在写入中途断电，留下的是一个
   * 截断的 JSON，下次启动只能整份丢弃。改名在同一目录内是原子的。
   */
  const flush = async (): Promise<void> => {
    if (!buckets.dirty) return
    const doc = buckets.snapshot()
    const temp = `${file}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temp, JSON.stringify(doc), "utf8")
      await rename(temp, file)
    } catch (err) {
      host.logger.warn(`消息统计写入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let lastDay = dayKey(Date.now())
  const timer = setInterval(() => {
    // 跨天时裁一次：不然长期不重启的实例会一直攒到内存里
    const today = dayKey(Date.now())
    if (today !== lastDay) {
      lastDay = today
      buckets.prune(Date.now())
    }
    void flush()
  }, FLUSH_MS)
  // 统计不该拖住进程退出
  timer.unref?.()

  const offStop = host.on("app/stopping", (() => flush()) as (...args: never[]) => unknown)

  host.logger.debug(`消息统计已启动，数据文件 ${file}`)
  return {
    read: () => buckets.snapshot(),
    stop: async () => {
      clearInterval(timer)
      offRecv()
      offSent()
      offStop()
      await flush()
    }
  }
}
