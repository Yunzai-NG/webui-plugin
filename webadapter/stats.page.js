/**
 * 模块职责：消息统计页面的浏览器侧 —— 走数据桥取数、按选定范围聚合、画图与表
 * 依赖方向：只依赖同目录的 msgstats.js（构建时从 dist 拷来，见 scripts/sync-webadapter.mjs）
 * 生命周期：随 iframe 加载与销毁；无定时器之外的常驻状态
 * 注意事项：**范围筛选在这里算，不在服务端。** 数据桥的路径白名单不含 `?`（见
 *          web/src/custombridgegate.ts），参数过不去；服务端一次送出按天分桶的全量，
 *          区间聚合由 `aggregate()` 在此完成。
 *
 *          **聚合函数从 msgstats.js 引，不在本文件里重写一份。** 那份实现被
 *          src/msgstats.test.ts 的用例钉着；这里另写一份的话，被测的就不是真跑的那份，
 *          而两份分叉的表现是「图表数字不对」，不是报错。
 *
 *          **「今天」取服务端给的 `today`，不用本机的 `new Date()`。** 分桶键按服务端本地
 *          日期切，手机在国外看家里的机器人时，按本机日期去查会整段错位一天，且数据都在、
 *          只是少一天多一天，极难发现。
 *
 *          **不用 localStorage 存偏好。** iframe 的 sandbox 不带 allow-same-origin，源不透明，
 *          写不报错但下次打开就没了 —— 那比不存更让人困惑。
 *
 *          图表手写 SVG，不引图表库：四种图形加起来两百行，而引一个库要么进
 *          webui 的依赖（不用面板的部署也得背），要么从 CDN 取（离线部署直接空白）。
 *
 *          **本文件是经典脚本，不是 ES 模块，故聚合函数从全局取而非 `import`。**
 *          `<script type="module">` 的抓取一律走 CORS 模式，而本页所在的 iframe 不带
 *          allow-same-origin、源不透明（`Origin: null`），内核的静态挂载又不回
 *          `Access-Control-Allow-Origin` —— 模块脚本会被静默拦下：一行不执行、
 *          无任何报错，页面永远停在「读取中…」。改回 `import` 就会重现这个症状。
 */

/** msgstats 的聚合函数，由 webadapter/msgstats.js 挂在全局上（见 scripts/sync-webadapter.mjs） */
const { aggregate, aggregateHours, dayKey, shiftDay } = window.YZNG_MSGSTATS

/** 数据桥的消息类型标识，与 web/src/custombridgegate.ts 的 `BRIDGE_KIND` 一致 */
const BRIDGE_KIND = "yunzai-ng.custom"

/** 一次取数的超时毫秒：外壳没装桥时不能让页面一直停在「读取中」 */
const TIMEOUT_MS = 10_000

/** 外壳清单未就绪时的重试间隔与次数 */
const RETRY_MS = 400
const RETRY_MAX = 8

/** 递增的请求序号，用于把应答对上请求 */
let seq = 0

/**
 * 经数据桥取一次本插件的接口
 *
 * 每次请求带一个唯一 id，只认 id 相同的那条应答：页面里若同时有多处取数，
 * 不对 id 就可能把别人的应答当成自己的。
 * @param {string} path 接口路径，相对本插件的接口前缀
 * @returns {Promise<unknown>} 应答数据
 */
function bridgeGet(path) {
  return new Promise((resolve, reject) => {
    const id = `stats-${(seq += 1)}`
    /**
     * 收应答
     * @param {MessageEvent} event 消息事件
     */
    const onMessage = event => {
      const body = event.data
      if (body === null || typeof body !== "object") return
      if (body.kind !== BRIDGE_KIND || body.id !== id) return
      window.removeEventListener("message", onMessage)
      clearTimeout(timer)
      if (body.ok === true) resolve(body.data)
      else reject(new Error(typeof body.error === "string" ? body.error : "取数失败"))
    }

    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage)
      reject(new Error("取数超时，面板可能未装好数据桥"))
    }, TIMEOUT_MS)

    window.addEventListener("message", onMessage)
    // targetOrigin 用 "*"：本页的源是不透明的，填具体值投递不到（理由见 web/src/custombridge.ts）
    window.parent.postMessage({ kind: BRIDGE_KIND, id, path, self: true }, "*")
  })
}

/**
 * 取统计，遇「插件标识未就绪」时重试
 *
 * 外壳要先拉到页面清单才知道当前页属于哪个插件，在那之前 `self` 请求会被拒（见
 * custombridgegate.ts）。这不是错误而是时序，故重试而不是把那句话摔给使用者 ——
 * 否则首次打开会偶发一句「稍后再试」，刷新一下又好了。
 * @returns {Promise<object>} 统计返回体
 */
async function fetchStats() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await bridgeGet("stats")
    } catch (err) {
      const retriable = String(err.message).includes("尚未确定") && attempt < RETRY_MAX
      if (!retriable) throw err
      await new Promise(done => setTimeout(done, RETRY_MS))
    }
  }
}

/* ────────────────────────────── 状态 ────────────────────────────── */

/** 当前选中的时间跨度：`"today"` | `"1"` | `"7"` | `"30"` | `"custom"` */
let span = "today"

/** 当前图表形状 */
let chartKind = "bar"

/**
 * 当前统计项：`all` | `messages` | `images` | `stickers`
 *
 * 缺省是 `all` —— 打开这一页最先想知道的是「有没有在动」，而不是「图片有几张」。
 * 那一档把三项同时画上，故图例要说明颜色（见 `drawLegend`）。
 */
let metric = "all"

/** 服务端送来的按天分桶全量 */
let doc = { version: 2, days: {} }

/** 服务端的「今天」，一切范围以它为基准 */
let today = dayKey(Date.now())

/**
 * 服务端此刻的毫秒时间戳
 *
 * 「当日」与「1 日」两档要按小时切，而小时边界必须用**服务端的**此刻：浏览器与服务端
 * 不在同一时区时，用本机的 `Date.now()` 会让 24 格整段错位，且错得看不出来。
 * 首次取数前先用本机的顶上，那一瞬间还没有数据可画。
 */
let serverNow = Date.now()

/** 小时桶保留多少天，服务端给；决定「按小时」最远能看到哪天 */
let hourKeepDays = 7

/** 自定义范围的两端，初值在首次取数后按 today 填 */
let customFrom = ""
let customTo = ""

/**
 * 只看这个账号，键为 `platform:accountId`；空串表示全部账号
 *
 * 缺省全部：多账号部署里「一共收了多少」才是首屏该答的问题，按号拆分是追问。
 */
let account = ""

/* ────────────────────────────── 取元素 ────────────────────────────── */

/**
 * 按 id 取一个元素
 * @param {string} id 元素 id
 * @returns {HTMLElement} 元素
 */
const el = id => document.getElementById(id)

/* ────────────────────────────── 范围换算 ────────────────────────────── */

/**
 * 按当前选择聚合出一份视图
 *
 * 两种粒度，由跨度决定，**不给使用者一个「按天/按小时」开关**：那个开关的正确取值
 * 完全由跨度推得（30 天按小时是 720 格，挤成一片糊；当天按天只有一根柱），
 * 多一个能拨错的旋钮不如不给。
 *
 * - 「当天」：服务端当天 00:00 到此刻，按小时 —— 格数随时间推移由 1 长到 24。
 * - 「1 日」：此刻往前 24 小时，按小时，会跨过昨天那一段。
 * - 其余：按天。
 *
 * 「当天」与「1 日」不再是「今天 vs 昨天」（此前如此），而是「今天以来 vs 最近 24 小时」——
 * 前者答「今天忙不忙」，后者答「刚过去这一整天什么时候忙」，两者都以此刻为右端。
 * @returns {object} 聚合结果，形如 `aggregate()` 的返回值
 */
function currentView() {
  if (span === "today") {
    // 从当天 00:00 到此刻共几格：`getHours()` 是本机时区的小时数，而 serverNow
    // 已是服务端时刻，两者在同一时区下一致；跨时区时以服务端的日界为准更要紧
    const hours = new Date(serverNow).getHours() + 1
    return aggregateHours(doc, serverNow, hours, account === "" ? undefined : account)
  }
  if (span === "1") return aggregateHours(doc, serverNow, 24, account === "" ? undefined : account)

  const range = rangeOfDays()
  return aggregate(doc, range.from, range.to, account === "" ? undefined : account)
}

/**
 * 按天那几档的起止日期键
 * @returns {{from: string, to: string}} 起止日期键
 */
function rangeOfDays() {
  if (span === "custom") {
    const from = customFrom !== "" ? customFrom : today
    const to = customTo !== "" ? customTo : today
    // 顺序写反时不报错也不空白，`aggregate` 内部会把两端换过来（见 msgstats.ts）
    return { from, to }
  }
  const days = Number(span)
  return { from: shiftDay(today, -(days - 1)), to: today }
}

/**
 * 把日期键写成人能读的样子
 * @param {string} day 日期键
 * @returns {string} 如 `9 月 11 日`
 */
function humanDay(day) {
  const parts = day.split("-")
  return `${Number(parts[1])} 月 ${Number(parts[2])} 日`
}

/* ────────────────────────────── 画图 ────────────────────────────── */

/** SVG 命名空间 */
const SVG_NS = "http://www.w3.org/2000/svg"

/** 图表内边距：左侧留给刻度数字，底部留给日期 */
const PAD = { top: 12, right: 8, bottom: 26, left: 40 }

/**
 * 造一个 SVG 元素
 * @param {string} tag 标签名
 * @param {Record<string, string|number>} attrs 属性
 * @returns {SVGElement} 元素
 */
function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/**
 * 取一个「好看」的纵轴上限
 *
 * 直接用最大值当上限的话，最高那根柱顶到边框，且刻度是 37 之类的数。向上取整到
 * 1/2/5×10^n 使刻度总是整数。
 * @param {number} max 数据最大值
 * @returns {number} 纵轴上限，至少为 1
 */
function niceMax(max) {
  if (max <= 0) return 1
  const exp = Math.floor(Math.log10(max))
  const base = 10 ** exp
  for (const step of [1, 2, 5, 10]) {
    if (max <= step * base) return step * base
  }
  return 10 * base
}

/**
 * 横轴上该标出哪几天
 *
 * 30 天全标会挤成一团糊字，故按宽度定间隔，且**总是标最后一天** —— 使用者最想确认的
 * 是「右边这根是不是今天」。
 * @param {number} count 天数
 * @returns {number} 每隔几个标一个
 */
function labelStep(count) {
  if (count <= 8) return 1
  if (count <= 16) return 2
  return Math.ceil(count / 8)
}

/**
 * 统计项的显示名
 *
 * 放在 `seriesOf` 之前而不是渲染那一节：那里是它原来的位置，但 `seriesOf` 要读它，
 * 而 `const` 有暂时性死区 —— 现在的调用时序侥幸安全（只在 `render()` 里调），
 * 下一个人把 `seriesOf` 挪到模块顶层求值一次就会撞上 ReferenceError。
 */
const METRIC_NAME = { messages: "消息", images: "图片", stickers: "表情包" }

/**
 * 一张图上要画哪几条系列
 *
 * 「全部」把三个统计项一并画出，故有 6 条（收发各三）；单选某一项时只有 2 条。
 *
 * **颜色只在这张表里写一次**，图例读的是同一个函数（见 `drawLegend`）—— 两处各写一份的话，
 * 改了图里的颜色而忘了图例，表现是「图例说蓝色是消息，图上蓝色其实是图片」，
 * 而那种错没有任何报错，只会让人读错数据。
 * @param {string} key 统计项：all | messages | images | stickers
 * @returns {{name: string, color: string, dir: string, metric: string}[]} 系列描述
 */
function seriesOf(key) {
  if (key !== "all") {
    return [
      { name: `收到${METRIC_NAME[key]}`, color: "var(--recv)", dir: "recv", metric: key },
      { name: `发出${METRIC_NAME[key]}`, color: "var(--sent)", dir: "sent", metric: key }
    ]
  }
  return [
    { name: "收到消息", color: "var(--recv)", dir: "recv", metric: "messages" },
    { name: "发出消息", color: "var(--sent)", dir: "sent", metric: "messages" },
    { name: "收到图片", color: "var(--recv-img)", dir: "recv", metric: "images" },
    { name: "发出图片", color: "var(--sent-img)", dir: "sent", metric: "images" },
    { name: "收到表情包", color: "var(--recv-stk)", dir: "recv", metric: "stickers" },
    { name: "发出表情包", color: "var(--sent-stk)", dir: "sent", metric: "stickers" }
  ]
}

/**
 * 取一格里某条系列的数值
 * @param {object} item 一格数据
 * @param {object} def 系列描述
 * @returns {number} 数值
 */
function pickValue(item, def) {
  return item[def.dir][def.metric]
}

/**
 * 横轴那一格该写什么
 *
 * 按天时标签是 `YYYY-MM-DD`，去掉年份 —— 带年份在 30 天的图上必然重叠。按小时时标签
 * 已是 `HH` 或 `MM-DD HH`（见 `aggregateHours`），原样写出。
 * @param {string} label 序列给的标签
 * @returns {string} 横轴文字
 */
function axisLabel(label) {
  return /^\d{4}-\d{2}-\d{2}$/.test(label) ? label.slice(5) : label
}

/**
 * 把一格的身份写成完整时间
 *
 * 与 `axisLabel` 的取舍相反：横轴要短到不重叠，tooltip 要一眼读出是哪天几点。
 * 服务端给的 `at` 按天是 `YYYY-MM-DD`、按小时是 `YYYY-MM-DD HH`，**恒带日期** ——
 * 「按小时·近 7 天」那个视图里只写 `13` 的话，13 点是哪天根本读不出来。
 *
 * 粒度由字符串自身判定（带不带小时那一段），不必另外把 `unit` 传进画图函数：
 * 多一个参数就多一处可能与数据对不上的地方。
 *
 * 认不出的值原样返回：旧版服务端不给 `at`，此时上游退回 `label`，写出来仍是原先那样，
 * 而不是一句 `Invalid Date`。
 * @param {string} at 那一格的身份
 * @returns {string} 人能读的时间
 */
function momentLabel(at) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}))?$/.exec(String(at))
  if (match === null) return String(at)
  const [, year, month, day, hour] = match
  const now = new Date()
  // 当年不写年份：一张 30 天的图上每格都重复同一个「2026 年」只是噪声
  const head = Number(year) === now.getFullYear() ? "" : `${year}年`
  const date = `${head}${Number(month)}月${Number(day)}日`
  return hour === undefined ? date : `${date} ${hour}:00`
}

/**
 * 画一张图
 * @param {readonly object[]} series 逐格的收发数据，每格带 `label`
 * @param {string} kind 图形：bar | line | area | stack
 * @param {string} key 统计项：all | messages | images | stickers
 */
function drawChart(series, kind, key) {
  const node = el("chart")
  node.replaceChildren()
  /*
   * 上一次的读数一并清掉
   *
   * 不清的话，切了时间范围或统计项之后，图下还留着一行属于旧视图的数字 —— 它不会报错，
   * 只是安静地对不上。
   */
  const readout = el("chartReadout")
  if (readout !== null) readout.textContent = ""

  /*
   * viewBox 按**实测容器宽度**取，且不写 `preserveAspectRatio="none"`
   *
   * 写死 720 宽再配 `none` 的话，浏览器会把这 720 个用户单位横向拉满容器（本页在面板里
   * 实测约 1400px）而纵向不变 —— 近 2 倍的横向拉伸：柱子变胖、刻度数字与日期一并被拉扁。
   * 那正是「图表看着扁扁的」的由来。
   *
   * 首帧量到 0 是真实存在的（iframe 布局未定），故兜底回 720 并在 `ResizeObserver` 里重画：
   * 宽度一旦确定就会再画一次，使用者看不到那一帧。
   */
  const measured = Math.round(node.getBoundingClientRect().width)
  // 先判「量到了没有」再取下限：写成 `Math.max(measured, 320) || 720` 的话后半永不生效
  // （前半恒 ≥ 320），首帧会按 320 画一张窄图
  const W = measured < 1 ? 720 : Math.max(measured, 320)
  const H = 260
  node.setAttribute("viewBox", `0 0 ${W} ${H}`)
  node.removeAttribute("preserveAspectRatio")

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  if (series.length === 0) {
    node.append(
      svg("text", { x: W / 2, y: H / 2, "text-anchor": "middle" })
    )
    node.lastChild.textContent = "这段时间没有数据"
    return
  }

  const defs = seriesOf(key)
  // 堆叠图的纵轴要按各条之和取，否则叠起来会顶出画布
  const peak = Math.max(
    ...series.map(item =>
      kind === "stack"
        ? defs.reduce((sum, def) => sum + pickValue(item, def), 0)
        : Math.max(...defs.map(def => pickValue(item, def)))
    )
  )
  const top = niceMax(peak)

  /**
   * 把一个数值折成纵坐标
   * @param {number} value 数值
   * @returns {number} y 坐标
   */
  const y = value => PAD.top + plotH - (value / top) * plotH

  /* 横向网格线与刻度：四条足够定位，再多就成了背景噪声 */
  for (let i = 0; i <= 4; i += 1) {
    const value = (top / 4) * i
    const yy = y(value)
    node.append(svg("line", { class: "grid-line", x1: PAD.left, y1: yy, x2: W - PAD.right, y2: yy }))
    const label = svg("text", { x: PAD.left - 6, y: yy + 3.5, "text-anchor": "end" })
    label.textContent = String(Math.round(value))
    node.append(label)
  }

  const slot = plotW / series.length
  const step = labelStep(series.length)

  /*
   * 横轴标签
   *
   * 标签由聚合层给（`item.label`），此处不再自己从日期键里切 —— 按小时那两档的标签是
   * `HH` 或 `MM-DD HH`，在这里按 `slice(5)` 切会把 `09` 切成空串。
   */
  series.forEach((item, i) => {
    const last = i === series.length - 1
    if (i % step !== 0 && !last) return
    const label = svg("text", { x: PAD.left + slot * (i + 0.5), y: H - 8, "text-anchor": "middle" })
    label.textContent = axisLabel(item.label)
    node.append(label)
  })

  /**
   * 一格上的悬停说明
   *
   * 「全部」那一档有六条，逐条列出来才读得懂哪个数字属于哪一项 —— 只写「收 x 发 y」
   * 时使用者无从知道那是消息还是图片。
   *
   * 时间取 `at` 而非 `label`：后者是**横轴标签**，为了不重叠而刻意做短 —— 按小时时它可能
   * 只是 `13`，而「按小时·近 7 天」这个视图里 13 点是哪天根本读不出来。
   * @param {object} item 那一格的数据
   * @returns {string} title 文本
   */
  const titleOf = item =>
    `${momentLabel(item.at ?? item.label)}\n${defs.map(def => `${def.name} ${pickValue(item, def)}`).join("\n")}`

  /**
   * 给一格铺一块整列高的透明感应区
   *
   * 悬停走 SVG 原生 `<title>`（sandbox 里没有 tooltip 库，够用），但它**只响应悬停** ——
   * 触屏上一个字都看不到，而 Termux 部署的人多半就是在手机上看这一页。故同一段文字在
   * 点选时写进图下的读数行：不另造一个要算位置、要防出界的浮层，一行字把「哪天几点、
   * 各项多少」说完即可。
   *
   * 感应区铺满整列而不是只盖住柱子：值为 0 的那几格压根没画矩形，只盖柱子的话它们点不中，
   * 而「这一小时是 0」恰恰是使用者想确认的事。
   * @param {object} item 那一格的数据
   * @param {number} i 第几格
   */
  const addHit = (item, i) => {
    const text = titleOf(item)
    const hit = svg("rect", {
      x: PAD.left + slot * i, y: PAD.top, width: slot, height: plotH,
      fill: "transparent", class: "hit"
    })
    const tip = svg("title", {})
    tip.textContent = text
    hit.append(tip)
    // pointerdown 而非 click：触屏上 click 要等约 300ms 的双击判定，点下去没有即时反馈
    hit.addEventListener("pointerdown", () => {
      const out = el("chartReadout")
      if (out !== null) out.textContent = text.replace(/\n/g, "　")
    })
    node.append(hit)
  }

  if (kind === "bar" || kind === "stack") {
    // 柱宽留 30% 空隙：紧贴在一起时数不清有几根
    const groupW = slot * 0.7
    // 并排时按条数均分：六条各占 1/6，否则「全部」那一档后几条会画到隔壁格里去
    const barW = kind === "stack" ? groupW : groupW / defs.length

    series.forEach((item, i) => {
      const x0 = PAD.left + slot * i + (slot - groupW) / 2

      if (kind === "stack") {
        // 自底向上累加：每条的底是前面各条之和，故要边画边记
        let base = 0
        defs.forEach(def => {
          const value = pickValue(item, def)
          if (value > 0) {
            node.append(
              svg("rect", {
                class: "bar", x: x0, y: y(base + value), width: barW,
                height: (value / top) * plotH, fill: def.color, rx: 2
              })
            )
          }
          base += value
        })
      } else {
        defs.forEach((def, k) => {
          const value = pickValue(item, def)
          if (value <= 0) return
          node.append(
            svg("rect", {
              class: "bar", x: x0 + barW * k, y: y(value), width: barW,
              height: (value / top) * plotH, fill: def.color, rx: 2
            })
          )
        })
      }

      addHit(item, i)
    })
    return
  }

  /* 折线与面积 */
  for (const def of defs) {
    const points = series
      .map((item, i) => `${PAD.left + slot * (i + 0.5)},${y(pickValue(item, def))}`)
      .join(" ")

    if (kind === "area") {
      const x0 = PAD.left + slot * 0.5
      const x1 = PAD.left + slot * (series.length - 0.5)
      const base = PAD.top + plotH
      /*
       * 六条面积叠在一起时透明度要更低
       *
       * 0.18 是为两条设的：六条相互压着时，底下那几条被染成一片看不出边界。
       * 这一档本就更适合看折线，面积只留一层淡淡的填充帮着分辨走势。
       */
      node.append(
        svg("polygon", {
          points: `${x0},${base} ${points} ${x1},${base}`,
          fill: def.color,
          opacity: defs.length > 2 ? 0.1 : 0.18
        })
      )
    }
    node.append(
      svg("polyline", {
        points, fill: "none", stroke: def.color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round"
      })
    )
    // 格子少时点出各格位置：单格时折线退化成一个点，不画圆点就什么也看不见
    if (series.length <= 14) {
      series.forEach((item, i) => {
        node.append(
          svg("circle", { cx: PAD.left + slot * (i + 0.5), cy: y(pickValue(item, def)), r: 2.5, fill: def.color })
        )
      })
    }
  }

  series.forEach((item, i) => {
    addHit(item, i)
  })
}

/* ────────────────────────────── 渲染 ────────────────────────────── */

/** 会话类型的显示名 */
const SCENE_NAME = { group: "群", private: "私聊", guild: "频道" }

/**
 * 画计数卡
 * @param {object} total 区间合计
 */
function drawTiles(total) {
  const box = el("tiles")
  box.replaceChildren()
  const items = [
    ["收到消息", total.recv.messages, "recv"],
    ["发出消息", total.sent.messages, "sent"],
    ["收到图片", total.recv.images, "recv"],
    ["发出图片", total.sent.images, "sent"],
    ["收到表情包", total.recv.stickers, "recv"],
    ["发出表情包", total.sent.stickers, "sent"]
  ]
  for (const [label, value, dir] of items) {
    const tile = document.createElement("div")
    tile.className = "tile"
    const head = document.createElement("div")
    head.className = "tile-label"
    const dot = document.createElement("i")
    dot.className = `dot dot-${dir}`
    head.append(dot, document.createTextNode(label))
    const num = document.createElement("div")
    num.className = "tile-value"
    // toLocaleString 加千位分隔：五位数以上不分隔时读起来要数位数
    num.textContent = value.toLocaleString("zh-CN")
    tile.append(head, num)
    box.append(tile)
  }
}

/**
 * 画会话表
 * @param {readonly object[]} peers 按会话的合计
 */
function drawPeers(peers) {
  const body = el("peerBody")
  body.replaceChildren()
  el("peerEmpty").hidden = peers.length > 0
  el("peerTable").hidden = peers.length === 0

  for (const peer of peers) {
    const row = document.createElement("tr")
    const name = document.createElement("td")
    // textContent 而非 innerHTML：群名由使用者自己改，含 `<` 时不该被当成标签
    name.textContent = peer.name
    const tag = document.createElement("span")
    tag.className = "tag"
    tag.textContent = SCENE_NAME[peer.scene] ?? peer.scene
    name.append(tag)
    row.append(name)
    for (const value of [
      peer.recv.messages, peer.sent.messages,
      peer.recv.images, peer.sent.images,
      peer.recv.stickers, peer.sent.stickers
    ]) {
      const cell = document.createElement("td")
      cell.textContent = value.toLocaleString("zh-CN")
      row.append(cell)
    }
    body.append(row)
  }
}

/**
 * 画图例
 *
 * 与图共读同一个 `seriesOf()`，故颜色与名称不可能对不上 —— 两处各写一份的话，改了图里的
 * 颜色而忘了图例，表现是「图例说这色是消息，图上其实是图片」，没有任何报错。
 * @param {string} key 统计项
 */
function drawLegend(key) {
  const box = el("legend")
  box.replaceChildren()
  for (const def of seriesOf(key)) {
    const item = document.createElement("span")
    const dot = document.createElement("i")
    dot.className = "dot"
    // 颜色由系列表给，不走 class：六条系列各有取值，写成六个类名只是把同一张表抄第二遍
    dot.style.background = def.color
    item.append(dot, document.createTextNode(def.name))
    box.append(item)
  }
}

/**
 * 这一档区间该怎么说
 * @param {object} view 聚合结果
 * @returns {{range: string, count: string, chart: string}} 三处副标题
 */
function captionsOf(view) {
  if (view.unit === "hour") {
    const hours = view.series.length
    const today = span === "today"
    return {
      range: today ? `${humanDay(dayKey(serverNow))} 00:00 起，至此刻` : "此刻往前 24 小时",
      count: today ? "今日以来合计" : "最近 24 小时合计",
      // 带上保留天数：小时桶只存近 hourKeepDays 天（见 msgstats.ts 的 HOUR_KEEP_DAYS），
      // 不说的话，使用者以为「按小时」这两档能一直往前翻，而更早只剩天汇总
      chart: `按小时 · ${hours} 格 · 小时分布仅保留近 ${hourKeepDays} 天`
    }
  }
  const same = view.from === view.to
  return {
    range: same
      ? `${humanDay(view.from)}（${view.from}）`
      : `${humanDay(view.from)} 至 ${humanDay(view.to)} · 共 ${view.series.length} 天`,
    count: same ? "当日合计" : `${view.series.length} 天合计`,
    chart: `按天 · ${view.series.length} 天`
  }
}

/** 按当前选择重画整页 */
function render() {
  /*
   * 账号下拉**必须先画**，不能排在 `currentView()` 之后
   *
   * `drawAccounts()` 会在两种情形下把 `account` 改回空串：账号数降到 1 以下（控件此时隐去，
   * 留着筛选就没法取消了），或已选的那个号在数据里消失了（换号、清过数据）。排在取视图之后
   * 的话，这一帧的图仍按那个旧筛选算出来，而下拉已经显示「全部账号」—— 两者对不上，
   * 且要等下一次重画才自愈。
   */
  drawAccounts()

  const view = currentView()
  const caps = captionsOf(view)
  const metricName = metric === "all" ? "全部" : METRIC_NAME[metric]

  el("rangeLabel").textContent = caps.range
  el("countSub").textContent = caps.count
  el("chartSub").textContent = `${caps.chart} · ${metricName}`
  el("peerSub").textContent = `${view.peers.length} 个会话，按消息总数排序`

  drawTiles(view.total)
  drawChart(view.series, chartKind, metric)
  drawLegend(metric)
  drawPeers(view.peers)

  /*
   * 读屏软件取不到 SVG 里的图形，故把结论写成一句话
   *
   * 「全部」时逐项各说一句而不是只报一个总数：把三项加在一起的那个数没有意义
   * （一条带两张图的消息会被记成 1 + 2），而分开说才对得上图上的六条。
   */
  const unitName = view.unit === "hour" ? "小时" : "日"
  const parts = seriesOf(metric).map(def => {
    const sum = view.total[def.dir][def.metric]
    return `${def.name} ${sum}`
  })
  const peak = view.series.reduce(
    (max, item) => Math.max(max, ...seriesOf(metric).map(def => pickValue(item, def))),
    0
  )
  el("chartDesc").textContent =
    `${metricName}趋势，${caps.range}，${parts.join("，")}，单${unitName}最高 ${peak}。`
}

/**
 * 把账号键写成人能读的样子
 * @param {string} key 账号键，`platform:account`
 * @param {object} ref 账号身份，可缺
 * @returns {string} 显示名
 */
function accountName(key, ref) {
  if (ref === undefined) return key
  // 适配器名放括号里：同一个 QQ 号在换适配器后仍是同一个账号，故它是补充而非主体
  const suffix = ref.adapter === "" ? "" : `（${ref.adapter}）`
  return `${ref.platform} · ${ref.account}${suffix}`
}

/**
 * 画账号下拉
 *
 * **只有一个账号时整行隐去**：那时下拉只有「全部账号」一项，点了没反应。多账号部署里
 * 它才是必需的 —— 而单账号部署（多数）不该为此多一行控件。
 *
 * 选项从文档的 `accounts` 表来，而不是从内核的账号列表来：这里要答的是「统计里有哪些账号」，
 * 而一个刚加上、还没收发过消息的账号在图上恒为 0，列出来只会让人以为筛选坏了。
 */
function drawAccounts() {
  const box = el("acctBox")
  const pick = el("acctPick")
  const refs = doc.accounts ?? {}
  const keys = Object.keys(refs).sort()

  box.dataset.on = keys.length > 1 ? "1" : "0"
  if (keys.length <= 1) {
    // 隐去时把筛选清掉：留着的话，那个账号消失后（换号、清数据）会剩一个筛不到东西的条件，
    // 而控件已经不可见，使用者无从取消它
    account = ""
    return
  }

  // 已选的账号在数据里消失时退回全部：否则整页恒为 0，而下拉显示着一个不存在的号
  if (account !== "" && !keys.includes(account)) account = ""

  pick.replaceChildren()
  const all = document.createElement("option")
  all.value = ""
  all.textContent = `全部账号（${keys.length} 个）`
  pick.append(all)
  for (const key of keys) {
    const option = document.createElement("option")
    option.value = key
    option.textContent = accountName(key, refs[key])
    pick.append(option)
  }
  pick.value = account
  el("acctHint").textContent = account === "" ? "" : "只统计这个账号收发的消息"
}

/**
 * 显示一条状态
 * @param {string} text 内容；空串则隐去
 * @param {boolean} bad 是否按错误显示
 */
function setStatus(text, bad) {
  const card = el("statusCard")
  const note = el("statusText")
  card.hidden = text === ""
  note.textContent = text
  note.classList.toggle("err", bad === true)
}

/* ────────────────────────────── 交互 ────────────────────────────── */

/**
 * 给一组分段按钮接上点击
 * @param {string} attr 区分按钮的属性名
 * @param {(value: string) => void} apply 选中后的动作
 */
function bindSeg(attr, apply) {
  const buttons = [...document.querySelectorAll(`button[data-${attr}]`)]
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button))
      apply(button.dataset[attr])
    })
  }
}

bindSeg("span", value => {
  span = value
  el("rangeBox").dataset.on = value === "custom" ? "1" : "0"
  render()
})

bindSeg("chart", value => {
  chartKind = value
  render()
})

bindSeg("metric", value => {
  metric = value
  render()
})

el("acctPick").addEventListener("change", event => {
  account = event.target.value
  render()
})

for (const [id, set] of [
  ["fromDate", v => (customFrom = v)],
  ["toDate", v => (customTo = v)]
]) {
  el(id).addEventListener("change", event => {
    set(event.target.value)
    // 空值不当作「从头开始」：那会把 40 天全画出来，而使用者只是清空了一个框
    if (customFrom === "" || customTo === "") {
      el("rangeHint").textContent = "两端都要填"
      return
    }
    el("rangeHint").textContent = customFrom > customTo ? "起止已自动对调" : ""
    render()
  })
}

/* ────────────────────────────── 启动 ────────────────────────────── */

/** 取一次数并重画 */
async function load() {
  try {
    const payload = await fetchStats()
    doc = payload?.doc ?? { version: 2, days: {} }
    today = typeof payload?.today === "string" ? payload.today : dayKey(Date.now())
    /*
     * 此刻取服务端的，且每次取数都更新
     *
     * 「当日」的格数是「此刻的小时数 + 1」，「1 日」是从此刻往前数 24 格 —— 两者都以此刻
     * 为右端。若只在页面加载时取一次，那个窗口就冻在打开页面的那一刻：挂着不动过了午夜，
     * 「当日」仍画着昨天的格子，而数据早已记到新的一天。
     *
     * 取服务端的而非 `Date.now()`：分桶键按服务端本地时区生成（见 msgstats.ts 的 `dayKey`），
     * 人在国外看家里的机器人时，用浏览器的此刻会整段错位，且错得看不出来。
     */
    if (typeof payload?.now === "number") serverNow = payload.now
    if (typeof payload?.hourKeepDays === "number") hourKeepDays = payload.hourKeepDays

    if (customFrom === "") {
      customFrom = shiftDay(today, -6)
      customTo = today
      el("fromDate").value = customFrom
      el("toDate").value = customTo
    }
    // 保留天数由服务端定，把可选下界告诉日期控件，免得选到一个必然为空的区间
    if (typeof payload?.keepDays === "number") {
      const floor = shiftDay(today, -(payload.keepDays - 1))
      for (const id of ["fromDate", "toDate"]) {
        el(id).min = floor
        el(id).max = today
      }
    }

    if (payload?.running === false) {
      setStatus("消息统计尚未开始采集 —— 重载 WebUI 插件后即会启动。下面显示的是空数据。", false)
    } else if (Object.keys(doc.days).length === 0) {
      setStatus("采集已在运行，但还没有任何记录。收到或发出第一条消息后即会出现。", false)
    } else {
      setStatus("", false)
    }
    render()
  } catch (err) {
    setStatus(`取统计失败：${err.message}`, true)
    render()
  }
}

void load()

// 数据每半分钟落一次盘，页面跟着这个节奏刷：更密只是重复取同一份快照
setInterval(() => void load(), 30_000)

/*
 * 宽度变了就重画
 *
 * viewBox 现在按实测宽度取（见 `drawChart`），不再靠浏览器拉伸兜着 —— 少了这一条，
 * 拖窗、折叠侧栏、乃至首帧量到 0 之后，图都会停在按旧宽度算出的坐标上。
 *
 * 只在宽度真的变了时重画：`ResizeObserver` 对高度变化同样会响，而本页图高固定，
 * 那种回调重画一遍毫无意义。
 */
let lastWidth = 0
new ResizeObserver(entries => {
  const width = Math.round(entries[0].contentRect.width)
  if (width === lastWidth || width === 0) return
  lastWidth = width
  render()
}).observe(el("chart"))
