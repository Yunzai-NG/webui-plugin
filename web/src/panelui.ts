/**
 * 模块职责：交给面板插件用的几样面板控件 —— 开关、图标、空状态、加载中
 * 依赖方向：依赖 vue 的 h / defineComponent 与面板自己的 AppIcon、EmptyState
 * 生命周期：模块级常量，经 `api.ui` 交给每个插件
 * 注意事项：**用这几样，就自动有主题的贴图。** 主题换开关的滑块、空状态的插图、加载中的那张图，
 *          挂的都是这些控件上的类名与 `data-part`；插件自己手写的开关是换不了皮的。
 *
 *          开关仍是原生复选框（与 SchemaField 里那枚同一套 DOM），故空格键切换与读屏播报都是白送的。
 *          插件拿到的是组件而非 `.vue` 文件，用 `api.h(api.ui.Switch, { … })` 渲染。
 */
import { defineComponent, h, type PropType } from "vue"
import AppIcon from "./components/AppIcon.vue"
import EmptyState from "./components/EmptyState.vue"

/** 开关：`checked` 进，`onChange(boolean)` 出 */
export const PanelSwitch = defineComponent({
  name: "PanelSwitch",
  props: {
    /** 是否打开 */
    checked: { type: Boolean, default: false },
    /** 是否停用 */
    disabled: { type: Boolean, default: false },
    /** 读屏器念出的名字；旁边没有可见文字时必填 */
    label: { type: String, default: undefined },
    /** 切换后回调 */
    onChange: { type: Function as PropType<(value: boolean) => void>, default: undefined }
  },
  setup(props) {
    return () =>
      h("label", { class: "switch", "data-part": "switch" }, [
        h("input", {
          type: "checkbox",
          checked: props.checked,
          disabled: props.disabled,
          "aria-label": props.label,
          onChange: (event: Event) => props.onChange?.((event.target as HTMLInputElement).checked)
        }),
        h("span", { class: "switch-track" })
      ])
  }
})

/** 加载中：主题给了 `loading` 槽位时换成那张图 */
export const PanelSpinner = defineComponent({
  name: "PanelSpinner",
  setup() {
    return () => h("span", { class: "spinner", "data-part": "loading", "aria-hidden": "true" })
  }
})

/** 交给插件的控件表 */
export const PANEL_UI = {
  /** 开关 */
  Switch: PanelSwitch,
  /** 线稿图标：`path` 是 24×24 网格上的 svg path 数据，颜色取 `currentColor` */
  Icon: AppIcon,
  /** 空状态：`icon`、`title`、`hint`，默认插槽放动作按钮 */
  EmptyState,
  /** 加载中 */
  Spinner: PanelSpinner
} as const

/** `api.ui` 的类型 */
export type PanelUi = typeof PANEL_UI
