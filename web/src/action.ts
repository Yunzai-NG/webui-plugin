/**
 * 模块职责：页面上「点一下发一次请求」的动作 —— 共用一条错误横幅与一个忙碌标记
 * 依赖方向：只依赖 vue 的响应式与 format 的 `errorText`
 * 生命周期：调用方 setup 时取一份，随组件存活
 * 注意事项：`busy` 存动作的键（多为条目名），模板据它只禁用那一行的按钮。
 *          错误在开始时清而非成功后清：任务末尾常接着重读列表，那一步自己写的错误不能被盖掉。
 */
import { ref } from "vue"
import { errorText } from "./format.js"

/**
 * 取一组动作的状态与执行入口
 * @returns `error` 为最近一次失败的文案，`busy` 为进行中动作的键，空串均意为无
 */
export function useAction() {
  const error = ref("")
  const busy = ref("")

  /**
   * 跑一个动作：先清错误，失败写进 `error` 而不往外抛，结束时复位 `busy`
   * @param key 写进 `busy` 的键
   * @param task 动作本身
   */
  async function run(key: string, task: () => Promise<void>): Promise<void> {
    busy.value = key
    error.value = ""
    try {
      await task()
    } catch (err) {
      error.value = errorText(err)
    } finally {
      busy.value = ""
    }
  }

  return { error, busy, run }
}
