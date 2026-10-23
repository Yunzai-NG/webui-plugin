<script setup lang="ts">
/**
 * 模块职责：右下角的通知按钮与历史抽屉 —— 回看收起了的回执，逐条或整批已读、删除
 * 依赖方向：依赖 toast.ts 的历史、format 与 Modal
 * 生命周期：由 `App.vue` 挂一个实例，全部页面都在
 * 注意事项：**点开抽屉不自动全部已读。** 未读数是「这几条我还没看」的记号，一打开就清零的话，
 *          抽屉里一长串时使用者分不出哪几条是新来的。点一条即读那一条，另有「全部已读」。
 */
import { computed, ref } from "vue"
import { ago, datetime } from "../format.js"
import { ICONS } from "../icons.js"
import { clearNotices, notices, readAllNotices, readNotice, removeNotice } from "../toast.js"
import AppIcon from "./AppIcon.vue"
import Modal from "./Modal.vue"

const open = ref(false)
const unread = computed(() => notices.value.filter(one => !one.read).length)

/** 铃铛的路径；图标表里没有，就写在这里 */
const BELL = "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
</script>

<template>
  <button
    type="button"
    class="notice-btn"
    data-part="notices"
    :aria-label="unread > 0 ? `通知，${unread} 条未读` : '通知'"
    title="最近的通知"
    @click="open = true"
  >
    <AppIcon class="notice-ico" :path="BELL" />
    <span v-if="unread > 0" class="notice-badge">{{ unread > 99 ? "99+" : unread }}</span>
  </button>

  <Modal :open="open" side title="最近的通知" :sub="`留最近 ${notices.length} 条，存在本浏览器里`" @close="open = false">
    <div v-if="notices.length > 0" class="row notice-tools">
      <button :disabled="unread === 0" @click="readAllNotices()">全部已读</button>
      <button class="danger" @click="clearNotices()">全部删除</button>
    </div>
    <ul v-if="notices.length > 0" class="notice-list">
      <li v-for="one in notices" :key="one.id" class="notice-item" :class="{ unread: !one.read }">
        <button type="button" class="notice-body" :aria-label="one.read ? one.text : `未读：${one.text}`" @click="readNotice(one.id)">
          <span class="notice-text">{{ one.text }}</span>
          <time class="hint" :datetime="new Date(one.at).toISOString()" :title="datetime(one.at)">
            {{ ago(one.at) }} · {{ datetime(one.at) }}
          </time>
        </button>
        <button
          v-if="!one.read"
          type="button"
          class="icon"
          aria-label="标为已读"
          title="标为已读"
          @click="readNotice(one.id)"
        >
          <AppIcon :path="ICONS.check" />
        </button>
        <button type="button" class="icon" aria-label="删除这条" title="删除" @click="removeNotice(one.id)">✕</button>
      </li>
    </ul>
    <p v-else class="hint">还没有通知。保存、安装、更新这类操作的回执会记在这里。</p>
  </Modal>
</template>
