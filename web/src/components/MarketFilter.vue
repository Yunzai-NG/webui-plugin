<!--
  模块职责：两个市场页共用的筛选条 —— 一行工具栏，其下一块可展开的多维筛选面板
  依赖方向：只依赖 filter.ts 的纯函数与类型；不认识 MarketItem / PanelStoreItem 任何一方
  生命周期：随所在页面；展开状态是组件自己的，判据由父级持有（v-model）
  注意事项：**分类那一排从「常驻卡片上方」搬进了可展开面板。** 从前它摊在卡片之上，七个条目
            就已占掉两行、把首屏卡片压下去一截 —— 而那一排在多数时候没人点。收起后只留
            一行工具栏，加一行「已选」小标签。

            **收起时仍要看得见筛掉了什么。** 面板一合上，「怎么只剩 3 个」就没有答案了，故
            「已选」那一行在有判据时照常出现，每枚小标签点一下即撤掉那一条。按钮上的角标也是
            为此：它数的是**面板里**那几维，不数页签与关键词 —— 那两样自己就摆在外面看得见，
            算进角标会让人以为面板里还藏着东西。

            **本组件不认字段名。** 版本门那一维在插件市场是 `minCore`、在面板商店是 `minWebui`，
            故取值由父级算好（`gatesOf`）后以 `gates` 传进来，标签文案也由父级给。在这里认死
            一个字段名，等于让这两页只有一页筛得动。

            **可见条目仍由父级算。** 本组件只管呈现与改判据；两页的 `visible` 各自还要叠上
            自己那一份 `ctx`（取值函数与当前版本），搬进来只会让父级去反查组件里发生了什么。
-->
<script setup lang="ts">
import { computed, ref } from "vue"
import {
  FITS_GATE,
  activeCount,
  authorFacets,
  emptyCriteria,
  initialsOf,
  sourceFacets,
  tagFacets,
  toggleTag,
  type Criteria,
  type Filterable
} from "../filter.js"

const props = defineProps<{
  /** 全部条目，供各维算出可选项与条目数 */
  items: readonly Filterable[]
  /** 索引里声明过的版本门，已升序去重；由父级 `gatesOf` 算出 */
  gates: readonly string[]
  /** 版本门这一维叫什么，如「内核」「面板」 */
  gateLabel: string
  /** 当前内核 / 面板版本；读不到时「装得上的」那一项不出现 */
  current?: string
  /** 搜索框的占位文案 */
  placeholder: string
  /** 搜索框的无障碍名 */
  searchLabel: string
  /** 当前判据 */
  modelValue: Criteria
}>()

const emit = defineEmits<{ "update:modelValue": [Criteria] }>()

/** 面板是否展开；组件自己的状态，切页签不该把它合上 */
const open = ref(false)

/** 各维可选项 */
const initials = computed(() => initialsOf(props.items))
const tags = computed(() => tagFacets(props.items))
const authors = computed(() => authorFacets(props.items))

/**
 * 索引来源
 *
 * **只有两个以上来源时这一行才出现。** 只配了一个索引源的人（绝大多数）看到的会是一枚
 * 点了等于没点的按钮 —— 全部条目都来自它。
 */
const sources = computed(() => {
  const found = sourceFacets(props.items)
  return found.length > 1 ? found : []
})

/** 面板里生效了几维，供按钮角标 */
const active = computed(() => activeCount(props.modelValue))

/**
 * 改一项判据
 * @param patch 要盖掉的那几项
 */
function patch(patch: Partial<Criteria>): void {
  emit("update:modelValue", { ...props.modelValue, ...patch })
}

/**
 * 切一排里的一个取值
 * @param key 哪一维
 * @param value 被点的取值
 */
function toggle(key: "tags" | "initials" | "authors" | "sources", value: string): void {
  patch({ [key]: toggleTag(props.modelValue[key] ?? [], value) })
}

/**
 * 这个取值当前选中了吗
 * @param key 哪一维
 * @param value 取值
 * @returns 是否选中
 */
function on(key: "tags" | "initials" | "authors" | "sources", value: string): boolean {
  return (props.modelValue[key] ?? []).includes(value)
}

/** 一枚「已选」小标签 */
interface Chip {
  /** 供 key */
  id: string
  /** 标签上的字 */
  label: string
  /** 撤掉这一条 */
  drop: () => void
}

/**
 * 收起态那一行「已选」
 *
 * 顺序与面板里各行一致，故撤掉一条之后其余不会跳位。**来源用尾段呈现**：索引地址动辄
 * 七八十字符，整条摆在小标签里会把这一行撑成一堵墙。
 */
const chips = computed<Chip[]>(() => {
  const out: Chip[] = []
  const c = props.modelValue

  if (c.onlyOfficial === true) {
    out.push({ id: "official", label: "仅官方维护", drop: () => patch({ onlyOfficial: false }) })
  }
  for (const one of c.initials ?? []) {
    out.push({ id: `i:${one}`, label: `首字母 ${one}`, drop: () => toggle("initials", one) })
  }
  for (const one of c.tags ?? []) {
    out.push({ id: `t:${one}`, label: one, drop: () => toggle("tags", one) })
  }
  if ((c.gate ?? "") !== "") {
    const gate = c.gate ?? ""
    out.push({
      id: "gate",
      label: gate === FITS_GATE ? `${props.gateLabel} ${props.current ?? ""} 装得上` : `需要${props.gateLabel} ${gate} 及以上`,
      drop: () => patch({ gate: "" })
    })
  }
  for (const one of c.authors ?? []) {
    out.push({ id: `a:${one}`, label: `作者 ${one}`, drop: () => toggle("authors", one) })
  }
  for (const one of c.sources ?? []) {
    out.push({ id: `s:${one}`, label: `来源 ${tailOf(one)}`, drop: () => toggle("sources", one) })
  }
  return out
})

/**
 * 索引地址的尾段，供小标签与选项文案
 *
 * 一条 raw.githubusercontent 的地址有七八十个字符，其中前六十个在几个来源之间完全相同 ——
 * 摆出来占满一行却分辨不出谁是谁。尾段（文件名）恰是各来源不同的那一截。
 * @param url 索引地址
 * @returns 尾段；切不出时原样返回
 */
function tailOf(url: string): string {
  const parts = url.split("/").filter(one => one !== "")
  return parts[parts.length - 1] ?? url
}

/** 一切复位，含页签与关键词 —— 按钮上写的是「清空全部」 */
function clearAll(): void {
  emit("update:modelValue", emptyCriteria())
}
</script>

<template>
  <div class="filterbar">
    <div class="toolbar">
      <input
        :value="modelValue.keyword ?? ''"
        type="search"
        :placeholder="placeholder"
        :aria-label="searchLabel"
        @input="patch({ keyword: ($event.target as HTMLInputElement).value })"
      />
      <label class="check">
        <input
          :checked="modelValue.onlyOfficial === true"
          type="checkbox"
          @change="patch({ onlyOfficial: ($event.target as HTMLInputElement).checked })"
        />
        <span class="checkmark"></span>
        仅官方维护
      </label>

      <!--
        展开按钮
        `aria-expanded` 与 `aria-controls` 一并给出：读屏器据此念出「已折叠 / 已展开」，
        而这枚按钮的全部作用就是那个状态
      -->
      <button
        :class="{ primary: open }"
        :aria-expanded="open"
        aria-controls="market-facets"
        @click="open = !open"
      >
        筛选 {{ open ? "▴" : "▾" }}
        <span v-if="active > 0" class="tag">{{ active }}</span>
      </button>

      <button v-if="active > 0 || (modelValue.keyword ?? '') !== ''" @click="clearAll()">清空全部</button>
    </div>

    <!--
      「已选」那一行
      面板展开时不再重复一遍 —— 那时每一维的选中状态就高亮在面板里，两处同时显示是同一件事说两遍
    -->
    <p v-if="!open && chips.length > 0" class="chosen">
      <span class="hint">已选</span>
      <button v-for="chip in chips" :key="chip.id" class="chip" @click="chip.drop()">
        {{ chip.label }}
        <span aria-hidden="true">×</span>
        <span class="sr-only">撤掉这一条</span>
      </button>
    </p>

    <div v-if="open" id="market-facets" class="filterpanel">
      <div v-if="initials.length > 0" class="filterrow">
        <span class="rowlabel">首字母</span>
        <span class="rowvals">
          <!--
            按英文包名取首字母，只列索引里出现过的那几个（见 filter.ts 的 initialsOf）——
            摆一个 26 格的字母表，其中十九格点下去必然是空结果
          -->
          <span
            v-for="one in initials"
            :key="one"
            class="tag pick"
            :class="{ on: on('initials', one) }"
            @click="toggle('initials', one)"
          >
            {{ one }}
          </span>
        </span>
      </div>

      <div v-if="tags.length > 0" class="filterrow">
        <span class="rowlabel">分类</span>
        <span class="rowvals">
          <span
            v-for="one in tags"
            :key="one.value"
            class="tag pick"
            :class="{ on: on('tags', one.value) }"
            @click="toggle('tags', one.value)"
          >
            {{ one.value }} <small>{{ one.count }}</small>
          </span>
        </span>
      </div>

      <!--
        版本门做成下拉而非一排标签：取值有序且互斥，一排标签会让人以为能多选。
        「装得上的」与具体版本装在同一个下拉里，因为两者本就互斥（见 matchesGate）
      -->
      <div v-if="gates.length > 0 || current" class="filterrow">
        <span class="rowlabel">{{ gateLabel }}</span>
        <span class="rowvals">
          <select
            :value="modelValue.gate ?? ''"
            :aria-label="`按${gateLabel}版本筛选`"
            @change="patch({ gate: ($event.target as HTMLSelectElement).value })"
          >
            <option value="">不限</option>
            <option v-if="current" :value="FITS_GATE">只看当前{{ gateLabel }}（{{ current }}）装得上的</option>
            <option v-for="one in gates" :key="one" :value="one">需要{{ gateLabel }} {{ one }} 及以上</option>
          </select>
        </span>
      </div>

      <div v-if="authors.length > 0" class="filterrow">
        <span class="rowlabel">作者</span>
        <span class="rowvals">
          <span
            v-for="one in authors"
            :key="one.value"
            class="tag pick"
            :class="{ on: on('authors', one.value) }"
            @click="toggle('authors', one.value)"
          >
            {{ one.value }} <small>{{ one.count }}</small>
          </span>
        </span>
      </div>

      <div v-if="sources.length > 0" class="filterrow">
        <span class="rowlabel">来源</span>
        <span class="rowvals">
          <span
            v-for="one in sources"
            :key="one.value"
            class="tag pick"
            :class="{ on: on('sources', one.value) }"
            :title="one.value"
            @click="toggle('sources', one.value)"
          >
            {{ tailOf(one.value) }} <small>{{ one.count }}</small>
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
