<script setup lang="ts">
/**
 * SessionsTab —— Sessions tab content 状态机（spec P4 §3.2 + C4）。
 *
 * 三态：list（默认，MobileSessionList）/ chat（MobileChatView，选中 session 后）/ new（MobileNewSession，s3-w2 接入）。
 * 替换 MobileShell 的 sessions tab 占位。
 * select → chat 态（记 selectedId）；back → list 态；new-session → new 态（s3-w2 接 MobileNewSession）。
 *
 * [CRITICAL-1] onMounted 触发 loadSessions —— renderer 在 Sidebar.vue onMounted 触发
 *   useSidebar().loadSessions()，mobile 不挂载 Sidebar，故在此触发（连接成功 + 进主界面后
 *   SessionsTab 随 MobileShell 首次挂载，与 renderer「shell 渲染→loadSessions」时机对齐）。
 * [CRITICAL-2] onSelect 调 useSidebar().selectSession(id) —— renderer Sidebar.vue:293 完整流程
 *   （switchSession RPC + 历史加载 + commands/context + 文件树预触发），而非仅切本地 view。
 *
 * s3-w1：list/chat 两态 + new 态入口（+ 按钮 emit new-session，但 new 态内容在 w2 接入，w1 暂回 list）。
 */
import { ref, onMounted } from 'vue'
import type { SessionsView } from './types'
import MobileSessionList from './MobileSessionList.vue'
import MobileChatView from '@/components/chat/MobileChatView.vue'
import MobileNewSession from './MobileNewSession.vue'
import { useSidebar } from '@/composables/features/useSidebar'
import { useToast } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'

const view = ref<SessionsView>('list')
const selectedId = ref<string | null>(null)

const emit = defineEmits<{ select: [sessionId: string] }>()

const { loadSessions, selectSession } = useSidebar()
const { error: toastError } = useToast()
const { t } = useI18n()

// [CRITICAL-1] 挂载时拉取 session 列表（对齐 renderer Sidebar.vue onMounted → loadSessions）
onMounted(() => {
  void loadSessions()
})

async function onSelect(sessionId: string): Promise<void> {
  // [CRITICAL-2] 调 selectSession 完整链路（switchSession RPC + 历史加载），
  // 而非仅切本地 view —— 否则 chatStore 历史恒空。对齐 renderer Sidebar.vue:293。
  try {
    await selectSession(sessionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('mobile.session.switchFailed', { msg }))
    return
  }
  selectedId.value = sessionId
  view.value = 'chat'
  // 透传给 MobileShell（供 Files tab 读该 session 的文件树）
  emit('select', sessionId)
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
