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
import type { OrchestrateNode, TaskNode } from '../types'

const props = defineProps<{
  currentSessionId: string | null
}>()

const sessionIdRef = computed(() => props.currentSessionId) as Ref<string | null>
const { messages, isStreaming, tokenUsage, send, currentTurnSegments, taskNodes, orchestrateNodes, toolUseToTaskId } = useChat(sessionIdRef)
const { createNewSession } = useSession()
const {
  selectMode, selectedIds, selectedCount, copied,
  toggleSelectMode, toggleMessage, selectAll,
  copySelected, copyAll,
} = useConversationCopy()

// 有子任务时显示右侧 sidebar
const showSidebar = computed(() =>
  taskNodes.value.size > 0 || orchestrateNodes.value.size > 0
)

// 选中的子 agent 节点（用于展示详情面板）
const selectedNodeId = ref<string | null>(null)
const selectedNode = computed<(OrchestrateNode & { _source: 'orchestrate' }) | (TaskNode & { _source: 'dispatch' }) | null>(() => {
  const id = selectedNodeId.value
  if (!id) return null
  const orch = orchestrateNodes.value.get(id)
  if (orch) return { ...orch, _source: 'orchestrate' as const }
  const task = taskNodes.value.get(id)
  if (task) return { ...task, _source: 'dispatch' as const }
  return null
})

// 活跃（running 状态）的子任务数，传给 StatusBar
const activeTaskCount = computed(() =>
  [...taskNodes.value.values()].filter(t => t.status === 'running').length
)

async function handleKillTask(taskId: string) {
  try { await killTask(taskId) } catch (e) { console.warn('[ChatView] kill failed:', e) }
}

function handleSelectNode(nodeId: string) {
  selectedNodeId.value = selectedNodeId.value === nodeId ? null : nodeId
}

// 流式时合并 currentTurnSegments 到最后一条 assistant 消息
const displayMessages = computed(() => {
  const msgs = [...messages.value]
  if (isStreaming.value && currentTurnSegments.value.length > 0) {
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        segments: [...(last.segments ?? []), ...currentTurnSegments.value],
      }
    } else {
      msgs.push({
        id: `streaming-${Date.now()}`,
        role: 'assistant',
        content: '',
        segments: [...currentTurnSegments.value],
        timestamp: new Date().toISOString(),
        isStreaming: true,
      })
    }
  }
  return msgs
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

// 监听 displayMessages 变化自动滚动
watch(
  [() => displayMessages.value.length, currentTurnSegments],
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
</script>

<template>
  <div class="flex h-full flex-1">
    <!-- 主聊天区域 -->
    <div class="flex h-full flex-1 flex-col bg-bg-surface">
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
            @click="copyAll(displayMessages)"
          >{{ copied ? 'Copied!' : 'Copy All' }}</button>
        </div>

        <div class="px-2 py-2">
          <!-- 选中节点信息面板 -->
          <div v-if="selectedNode" class="mb-2 rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-[12px]">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="font-mono font-bold text-blue-400">
                  {{ selectedNode._source === 'orchestrate'
                    ? (selectedNode.role === 'orchestrator' ? '[O]' : '[E]')
                    : 'λ' }}
                </span>
                <span class="font-mono text-text-primary font-semibold">{{ selectedNode.description }}</span>
              </div>
              <button
                class="text-text-secondary hover:text-text-primary text-[10px]"
                @click="selectedNodeId = null"
              >✕</button>
            </div>
            <div v-if="selectedNode._source === 'orchestrate'" class="space-y-1 text-text-secondary font-mono">
              <div>directive: {{ selectedNode.directive.slice(0, 200) }}{{ selectedNode.directive.length > 200 ? '...' : '' }}</div>
              <div class="flex gap-4">
                <span>depth: {{ selectedNode.depth }}</span>
                <span>status: {{ selectedNode.status }}</span>
                <span>tokens: {{ selectedNode.usage.total_tokens }}</span>
                <span>turns: {{ selectedNode.usage.tool_uses }}</span>
              </div>
            </div>
            <div v-else class="space-y-1 text-text-secondary font-mono">
              <div class="flex gap-4">
                <span>mode: {{ selectedNode.mode }}</span>
                <span>status: {{ selectedNode.status }}</span>
                <span>tokens: {{ selectedNode.usage.total_tokens }}</span>
              </div>
            </div>
          </div>

          <EmptyState v-if="messages.length === 0 && !selectedNode" />

          <div v-else class="space-y-2">
            <MessageBubble
              v-for="msg in displayMessages"
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
          @click="selectAll(displayMessages)"
        >Select All</button>
        <button
          class="rounded bg-accent px-2 py-0.5 font-mono text-[11px] text-white transition-colors hover:opacity-80 disabled:opacity-40"
          :disabled="selectedCount === 0"
          @click="copySelected(displayMessages)"
        >{{ copied ? 'Copied!' : `Copy ${selectedCount > 0 ? selectedCount : ''} Selected` }}</button>
        <span class="ml-auto font-mono text-[10px] text-text-tertiary">{{ selectedCount }} selected</span>
      </div>

      <MessageInput
        :is-streaming="isStreaming"
        @send="handleSend"
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
