/**
 * 模块职责：配置编辑的取值 —— 点号路径补丁的展开、深拷贝、以及「这次能不能用补丁」的判定
 * 依赖方向：无依赖，全为纯函数
 * 生命周期：纯函数
 * 注意事项：配置页与插件页的模态共用这一套保存逻辑，复制一份则下一次只会有一处被改对。
 *
 *          **`needsReplace()`**：服务端的 `patch()` 做深合并，`{ a: 1 }` 覆盖 `{ a: 1, b: 2 }`
 *          的结果仍含 `b`，于是键值对控件删掉一行、保存、刷新，那一行原样回来。判出「这次
 *          确实少了键」时改走 `PUT` 提交整份值，其余一律仍是补丁 —— 整份值会连带覆盖别处
 *          对同一文件的手改，故不能无条件用。
 *
 *          用例跑在 node 环境（无 jsdom，见 vitest.config.ts），故这些算法与组件分开：
 *          它们算错了都不报错，只表现为「保存了但没生效」或「保存把别的字段冲掉了」。
 */

/**
 * 是不是一个普通对象（非数组、非 null）
 * @param value 待判定的值
 * @returns 是否为普通对象
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 深拷贝一份配置值
 *
 * **不能用 `structuredClone`**：存进 `ref` 的对象是 Vue 的响应式代理，克隆代理会抛
 * DataCloneError —— 症状是页面顶部一条 "could not be cloned"、副本悄悄留空，
 * 于是「删掉了键」永远判不出来。
 *
 * JSON 往返对它无损：配置值本身就是从 JSON 响应里解出来的。
 * @param value 配置值
 * @returns 与响应式无关的普通对象
 */
export function snapshot(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

/**
 * 按点号路径取值
 * @param root 根对象
 * @param path 点号路径
 * @returns 该路径上的值；中途断开时 undefined
 */
export function pickPath(root: Record<string, unknown>, path: string): unknown {
  let node: unknown = root
  for (const part of path.split(".")) {
    if (!isPlainObject(node)) return undefined
    node = node[part]
  }
  return node
}

/**
 * 把点号路径的补丁展开为嵌套对象
 *
 * 服务端的 `patch()` 执行深合并，因此 `{"server":{"port":3000}}` 仅影响 port。
 * 此处必须展开，不可直接提交 `{"server.port":3000}` —— 后者会被视为一个名为
 * `server.port` 的顶层字段，校验必然失败。
 * @param dirty 改动过的路径 → 新值
 * @returns 嵌套补丁
 */
export function buildPatch(dirty: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(dirty)) {
    const parts = path.split(".")
    const leaf = parts.pop()
    if (leaf === undefined) continue
    let node = out
    for (const part of parts) {
      const existing = node[part]
      if (!isPlainObject(existing)) node[part] = {}
      node = node[part] as Record<string, unknown>
    }
    node[leaf] = value
  }
  return out
}

/**
 * 本次改动里是否有「删掉了键」的字典
 *
 * 只看改动路径上的那一层对象：字典的值本身若是对象，其内部的删除同样表达不了，
 * 但内核当前的 `s.record()` 只接受同构的值 schema，嵌套字典无从声明，故不深查。
 * 若日后支持了，此处需一并改为递归比较。
 * @param dirty 改动过的路径 → 新值
 * @param pristine 服务端那一份值的副本
 * @returns 是否需要整体替换
 */
export function needsReplace(dirty: Record<string, unknown>, pristine: Record<string, unknown>): boolean {
  for (const [path, value] of Object.entries(dirty)) {
    if (!isPlainObject(value)) continue
    const before = pickPath(pristine, path)
    if (!isPlainObject(before)) continue
    if (Object.keys(before).some(key => !Object.hasOwn(value, key))) return true
  }
  return false
}

/**
 * 就地把一个点号路径上的值写进配置对象
 *
 * 就地更新是必要的：`showWhen` 依赖同级字段的**当前**值，若仅记录补丁而不修改页面上
 * 那一份，则修改 `mode` 之后依赖它的字段不会随之显隐。
 *
 * 中途某一层不是对象时**放弃这一次写入而不是造出中间层**：那意味着补丁的路径与
 * schema 不符，此时造出一个 schema 里没有的对象只会让保存时的报错离原因更远。
 * @param root 配置对象，会被就地修改
 * @param path 点号路径
 * @param value 新值
 * @returns 是否写入成功
 */
export function assignPath(root: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = path.split(".")
  const leaf = parts.pop()
  if (leaf === undefined) return false
  let node = root
  for (const part of parts) {
    const next = node[part]
    if (!isPlainObject(next)) return false
    node = next
  }
  node[leaf] = value
  return true
}

/**
 * 按一份 schema 铺出它声明的默认值
 *
 * **为「从空表单起步」的场合而设** —— 新建账号那一处：内核配置的默认值由 node 侧填好再下发，
 * 而新建账号的表单从 `{}` 开始，于是 schema 里写着的 `default` 一个都没露面，使用者对着一排
 * 空框，还得自己去文档里查「连接地址该填什么」。
 *
 * **只铺 `default` 确实写了的字段。** 没声明默认值的字段不放进对象，也不放 `null` 或空串：
 * 那两样都是「使用者明确填了这个值」的意思，会连着提交上去，而 schema 里的可选字段本该缺席。
 *
 * **对象逐层递归，但空对象不留。** `properties` 里一项默认值都没有时，铺出一个 `{}` 只会让
 * 「有没有改过」的判定多出一层噪声。数组与字典原样取 `default`，不去猜元素。
 * @param schema 顶层描述，须为 object
 * @returns 默认值对象；一项都没有时为空对象
 */
export function defaultsOf(schema: {
  /** 字段类型 */
  type?: string
  /** 默认值 */
  default?: unknown
  /** 子字段 */
  properties?: Record<string, unknown>
}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const properties = schema.properties
  if (properties === undefined) return out

  for (const [key, raw] of Object.entries(properties)) {
    if (!isPlainObject(raw)) continue
    const child = raw as { type?: string; default?: unknown; properties?: Record<string, unknown> }

    if (child.type === "object" && child.properties !== undefined) {
      const inner = defaultsOf(child)
      // 空对象不留：见上文
      if (Object.keys(inner).length > 0) out[key] = inner
      continue
    }
    if (child.default !== undefined) out[key] = snapshot({ v: child.default }).v
  }
  return out
}
