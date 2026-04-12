<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, type Ref } from 'vue'
import { useChat } from '../composables/useChat'
import { useConversationCopy } from '../composables/useConversationCopy'
import { useSession } from '../composables/useSession'
import { getCurrentModel, listTools, isTauri, killTask } from '../lib/tauri'
import MessageBubble from './MessageBubble.vue'
import MessageInput from './MessageInput.vue'
import EmptyState from './EmptyState.vue'
import StatusBar from './StatusBar.vue'
import SubAgentSidebar from './SubAgentSidebar.vue'
import TabBar from './TabBar.vue'
import { useTabManager } from '../composables/useTabManager'
import type { ChatMessage } from '../types'

const props = defineProps<{
  currentSessionId: string | null
}>()

const sessionIdRef = computed(() => props.currentSessionId) as Ref<string | null>
const { messages, isStreaming, tokenUsage, send, cancel, currentTurnSegments, taskNodes, orchestrateNodes, toolUseToTaskId, setTabEventHandler } = useChat(sessionIdRef)
const { createNewSession } = useSession()
const tabManager = useTabManager(sessionIdRef)

// 注入 Tab 事件处理器：自动创建 Tab + 更新状态
setTabEventHandler((event) => {
  if (!sessionIdRef.value) return
  if (event.type === 'TaskCreated') {
    tabManager.openSubAgentTab(event.task_id, event.description, sessionIdRef.value, 'subagent')
  }
  if (event.type === 'OrchestrateNodeCreated') {
    tabManager.openSubAgentTab(event.node_id, event.description, sessionIdRef.value, 'orchestrate')
  }
  // 根据事件类型确定目标 tabId
  const tabId = event.type === 'TaskCreated' ? event.task_id
    : event.type === 'TaskCompleted' ? event.task_id
    : event.type === 'OrchestrateNodeCreated' ? event.node_id
    : event.type === 'OrchestrateNodeCompleted' ? event.node_id
    : ('source_task_id' in event && event.source_task_id) ? event.source_task_id
    : null
  if (tabId) {
    const status = tabManager.eventToTabStatus(event)
    if (status) tabManager.updateTabStatus(tabId, status)
  }
})

// session 变化时确保主 Tab 存在
watch(sessionIdRef, (newId) => {
  if (newId) tabManager.ensureMainTab(newId)
}, { immediate: true })
const {
  selectMode, selectedIds, selectedCount, copied,
  toggleSelectMode, toggleMessage, selectAll,
  copySelected, copyAll,
} = useConversationCopy()

// 有子任务时显示右侧 sidebar
const showSidebar = computed(() =>
  taskNodes.value.size > 0 || orchestrateNodes.value.size > 0
)

// 活跃（running 状态）的子任务数，传给 StatusBar
const activeTaskCount = computed(() =>
  [...taskNodes.value.values()].filter(t => t.status === 'running').length
)

async function handleKillTask(taskId: string) {
  try { await killTask(taskId) } catch (e) { console.warn('[ChatView] kill failed:', e) }
}

function handleSelectNode(nodeId: string) {
  const node = orchestrateNodes.value.get(nodeId) ?? taskNodes.value.get(nodeId)
  const type = orchestrateNodes.value.has(nodeId) ? 'orchestrate' : 'subagent'
  const title = node?.description ?? nodeId
  if (sessionIdRef.value) {
    tabManager.openSubAgentTab(nodeId, title, sessionIdRef.value, type)
  }
}

// 流式时合并 currentTurnSegments 到最后一条 assistant 消息
const getDisplayMessages = (msgs: ChatMessage[]) => {
  const result = [...msgs]
  if (isStreaming.value && currentTurnSegments.value.length > 0) {
    const last = result[result.length - 1]
    if (last?.role === 'assistant') {
      result[result.length - 1] = {
        ...last,
        segments: [...(last.segments ?? []), ...currentTurnSegments.value],
      }
    } else {
      result.push({
        id: `streaming-${Date.now()}`,
        role: 'assistant',
        content: '',
        segments: [...currentTurnSegments.value],
        timestamp: new Date().toISOString(),
        isStreaming: true,
      })
    }
  }
  return result
}

const currentMessages = computed(() => {
  if (tabManager.activeTabId.value === 'main') {
    return getDisplayMessages(messages.value)
  }
  return tabManager.tabMessages.value.get(tabManager.activeTabId.value) ?? []
})

// 运行时配置（从后端获取一次）
const modelName = ref('loading...')
const toolCount = ref(0)

onMounted(async () => {
  if (!isTauri()) return
  try {
    const [model, tools] = await Promise.all([getCurrentModel(), listTools()])
    modelName.value = model
    toolCount.value = tools.length
  } catch (err) {
    console.warn('[ChatView] failed to load runtime config:', err)
  }
})

const scrollContainer = ref<HTMLDivElement | null>(null)

// 监听 currentMessages 变化自动滚动
watch(
  [() => currentMessages.value.length, currentTurnSegments],
  async () => {
    await nextTick()
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  },
)

async function handleSend(content: string) {
  if (!sessionIdRef.value) {
    const newId = await createNewSession()
    if (!newId) return
    await nextTick()
  }
  send(content)
}

function handleCancel() {
  cancel()
}
</script>

<template>
  <div class="flex h-full flex-1">
    <!-- 主聊天区域 -->
    <div class="flex h-full flex-1 flex-col bg-bg-surface">
      <TabBar
        :tabs="tabManager.tabs.value"
        :active-tab-id="tabManager.activeTabId.value"
        @switch="tabManager.switchTab"
        @close="tabManager.closeTab"
      />

      <!-- 消息区域 -->
      <div ref="scrollContainer" class="flex-1 overflow-y-auto">
        <!-- 浮动工具栏 -->
        <div
          v-if="messages.length > 0"
          class="sticky top-0 z-10 flex justify-end gap-1 bg-bg-surface/80 px-2 pt-2 pb-1 backdrop-blur-sm"
        >
          <button
            class="rounded border border-border-default bg-bg-elevated px-2 py-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
            :class="{ 'border-accent text-accent': selectMode }"
            @click="toggleSelectMode"
          >{{ selectMode ? 'Cancel' : 'Select' }}</button>
          <button
            v-if="!selectMode"
            class="rounded border border-border-default bg-bg-elevated px-2 py-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
            @click="copyAll(currentMessages)"
          >{{ copied ? 'Copied!' : 'Copy All' }}</button>
        </div>

        <div class="px-2 py-2">
          <EmptyState v-if="currentMessages.length === 0" />

          <div v-else class="space-y-2">
            <MessageBubble
              v-for="msg in currentMessages"
              :key="msg.id"
              :message="msg"
              :is-streaming="msg.isStreaming"
              :task-nodes="taskNodes"
              :tool-use-to-task-id="toolUseToTaskId"
              :select-mode="selectMode"
              :selected="selectedIds.has(msg.id)"
              @toggle-select="toggleMessage"
            />
          </div>
        </div>
      </div>

      <!-- 选择模式操作栏 -->
      <div
        v-if="selectMode"
        class="flex items-center gap-2 border-t border-border-default bg-bg-elevated px-3 py-1.5"
      >
        <button
          class="rounded border border-border-default bg-bg-inset px-2 py-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:text-text-primary"
          @click="selectAll(currentMessages)"
        >Select All</button>
        <button
          class="rounded bg-accent px-2 py-0.5 font-mono text-[11px] text-white transition-colors hover:opacity-80 disabled:opacity-40"
          :disabled="selectedCount === 0"
          @click="copySelected(currentMessages)"
        >{{ copied ? 'Copied!' : `Copy ${selectedCount > 0 ? selectedCount : ''} Selected` }}</button>
        <span class="ml-auto font-mono text-[10px] text-text-tertiary">{{ selectedCount }} selected</span>
      </div>

      <MessageInput
        :is-streaming="isStreaming"
        @send="handleSend"
        @cancel="handleCancel"
      />

      <StatusBar
        :is-streaming="isStreaming"
        :model-name="modelName"
        :input-tokens="tokenUsage.inputTokens"
        :output-tokens="tokenUsage.outputTokens"
        :tool-count="toolCount"
        :active-task-count="activeTaskCount"
      />
    </div>

    <!-- 右侧 SubAgent Sidebar -->
    <SubAgentSidebar
      v-if="showSidebar"
      :task-nodes="taskNodes"
      :orchestrate-nodes="orchestrateNodes"
      @kill-task="handleKillTask"
      @select-node="handleSelectNode"
    />
  </div>
</template>
