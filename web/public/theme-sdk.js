/**
 * Yunzai NG 面板 · 扩展页主题 SDK
 *
 * 在扩展页的 HTML 里引一行：
 *
 *   <script src="/theme-sdk.js"></script>
 *
 * 面板每次换主题、换明暗，这里都会收到一条消息，随即：
 *   - 把面板的公开令牌（--text、--panel、--accent …）写成本页根上的 CSS 变量；
 *   - 在 <html> 上写好 data-scheme（light / dark）、data-theme-id 与 data-slots；
 *   - 派发一次 `yzng:theme` 事件，事件的 detail 即整条消息（含槽位图片的地址）。
 *
 * 再加 `data-base` 属性（`<script src="/theme-sdk.js" data-base></script>`）时，另注入一份按令牌写的
 * 基础样式：正文、标题、按钮、输入框、表格、卡片（.card）。页面自己的样式写在它之后即可覆盖。
 *
 * 不在面板里打开（直接访问页面地址）时什么都不会发生，页面用它自己的默认样式。
 *
 * 为什么是经典脚本而不是 ES 模块：扩展页在不带 allow-same-origin 的 iframe 里，源不透明，
 * `<script type="module">` 的抓取走 CORS 而面板的静态文件不回那个头 —— 模块脚本会被静默拦下。
 */
;(function () {
  "use strict"
  var KIND = "yunzai-ng.theme"
  var root = document.documentElement
  var me = document.currentScript
  var wantBase = me !== null && me.hasAttribute("data-base")
  var written = {}

  var BASE_CSS = [
    "html{color-scheme:light dark}",
    "body{margin:0;background:var(--bg);color:var(--text);font:var(--fs-body,14px)/1.65 var(--font-ui,system-ui,sans-serif)}",
    "h1,h2,h3{color:var(--text);line-height:1.3}",
    "h1{font-size:var(--fs-h1,22px)}h2{font-size:var(--fs-h2,16px)}h3{font-size:var(--fs-h3,13.5px)}",
    "a{color:var(--accent)}",
    "code,pre,kbd{font-family:var(--font-mono,monospace)}",
    "button{font:inherit;padding:var(--s2,8px) var(--s4,16px);border:1px solid var(--border);border-radius:var(--r-ctl,10px);background:var(--panel);color:var(--text);cursor:pointer}",
    "button:hover:not(:disabled){border-color:var(--accent)}",
    "button.primary{background:var(--accent-solid);border-color:var(--accent-solid);color:var(--on-accent)}",
    "input,select,textarea{font:inherit;padding:var(--s2,8px) var(--s3,12px);border:1px solid var(--border);border-radius:var(--r-ctl,10px);background:var(--panel);color:var(--text)}",
    "input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}",
    "table{border-collapse:collapse;width:100%}th,td{padding:var(--s2,8px) var(--s3,12px);border-bottom:1px solid var(--border);text-align:left}",
    "th{color:var(--muted);font-size:var(--fs-label,11.5px);font-weight:600}",
    ".card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r-card,14px);padding:var(--s5,20px)}",
    ".muted{color:var(--muted)}"
  ].join("\n")

  function injectBase() {
    if (!wantBase || document.getElementById("yzng-theme-base")) return
    var style = document.createElement("style")
    style.id = "yzng-theme-base"
    style.textContent = BASE_CSS
    // 放在最前：页面自己的样式写在后面即可盖过它
    document.head.insertBefore(style, document.head.firstChild)
  }

  function apply(msg) {
    var tokens = msg.tokens || {}
    for (var key in written) if (!(key in tokens)) root.style.removeProperty(key)
    written = {}
    for (var name in tokens) {
      if (name.indexOf("--") !== 0) continue
      root.style.setProperty(name, String(tokens[name]))
      written[name] = true
    }
    root.dataset.scheme = msg.scheme === "dark" ? "dark" : "light"
    root.dataset.themeId = String(msg.id || "classic")
    root.dataset.slots = Object.keys(msg.slots || {}).join(" ")
    root.dataset.lowPower = msg.lowPower ? "on" : "off"
    root.dataset.motion = msg.motion ? "full" : "off"
    root.dataset.yzngTheme = "on"
    injectBase()
    try {
      window.dispatchEvent(new CustomEvent("yzng:theme", { detail: msg }))
    } catch {
      // 极旧的浏览器没有 CustomEvent 构造函数：令牌已经写上了，少一个事件无妨
    }
  }

  window.addEventListener("message", function (event) {
    var data = event.data
    if (event.source !== window.parent || data === null || typeof data !== "object" || data.kind !== KIND) return
    if (data.type === "ready") return
    apply(data)
  })

  // 告诉面板「我起来了」：本脚本可能比 iframe 的 load 事件早或晚，面板收到这一条就补发一次
  if (window.parent !== window) window.parent.postMessage({ kind: KIND, type: "ready" }, "*")
})()
