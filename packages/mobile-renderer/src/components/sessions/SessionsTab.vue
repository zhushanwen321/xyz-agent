<script setup lang="ts">
/**
 * SessionsTab —— Sessions tab content 状态机（spec P4 §3.2 + C4）。
 *
 * 三态：list（默认，MobileSessionList）/ chat（MobileChatView，选中 session 后）/ new（MobileNewSession，s3-w2 接入）。
 * 替换 MobileShell 的 sessions tab 占位。
 * select → chat 态（记 selectedId）；back → list 态；new-session → new 态（s3-w2 接 MobileNewSession）。
 *
 * s3-w1：list/chat 两态 + new 态入口（+ 按钮 emit new-session，但 new 态内容在 w2 接入，w1 暂回 list）。
 */
import { ref } from 'vue'
import type { SessionsView } from './types'
import MobileSessionList from './MobileSessionList.vue'
import MobileChatView from '@/components/chat/MobileChatView.vue'
import MobileNewSession from './MobileNewSession.vue'

const view = ref<SessionsView>('list')
const selectedId = ref<string | null>(null)

function onSelect(sessionId: string): void {
  selectedId.value = sessionId
  view.value = 'chat'
}

function onBack(): void {
  view.value = 'list'
}

function onNewSession(): void {
  view.value = 'new'
}

function onCreated(sessionId: string): void {
  // MobileNewSession create 成功 → 进 chat 态
  selectedId.value = sessionId
  view.value = 'chat'
}

function onCancelNew(): void {
  view.value = 'list'
}
</script>

<template>
  <div class="sessions-tab h-full">
    <MobileSessionList
      v-if="view === 'list'"
      :selected-id="selectedId"
      @select="onSelect"
      @new-session="onNewSession"
    />
    <MobileChatView
      v-else-if="view === 'chat' && selectedId"
      :session-id="selectedId"
      @back="onBack"
    />
    <!-- new 态：MobileNewSession（手动路径输入，spec D4） -->
    <MobileNewSession
      v-else-if="view === 'new'"
      @created="onCreated"
      @cancel="onCancelNew"
    />
  </div>
</template>
