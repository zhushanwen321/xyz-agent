import { ref, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { sendMessage, cancelMessage, getHistory, onAgentEvent, isTauri } from '../lib/tauri'
import { transcriptToMessages } from '../lib/transcript'
import type {
  AgentEvent,
  AssistantSegment,
  ChatMessage,
  OrchestrateNode,
  TaskNode,
  ToolCallDisplay,
} from '../types'

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString() }
}

export function useChat(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([])
  const streamingText = ref('')
  const isStreaming = ref(false)
  const tokenUsage = ref({ inputTokens: 0, outputTokens: 0 })
  const currentTurnSegments = ref<AssistantSegment[]>([])
  const taskNodes = ref<Map<string, TaskNode>>(new Map())
  const orchestrateNodes = ref<Map<string, OrchestrateNode>>(new Map())
  // tool_use_id -> task_id 映射，用于 ToolCallCard 关联 SubAgentCard
  const toolUseToTaskId = ref<Map<string, string>>(new Map())
  let thinkingStartTime: number | null = null
  let unlisten: (() => void) | null = null
  // Tab 事件回调，由 ChatView 注入，用于自动创建/更新 Tab
  let tabEventHandler: ((event: AgentEvent) => void) | null = null
  let historyLoadPromise: Promise<void> | null = null

  function appendTextToCurrentTurn(text: string) {
    const segs = currentTurnSegments.value
    const last = segs[segs.length - 1]
    if (last && last.type === 'text') {
      last.text += text
    } else {
      segs.push({ type: 'text', text })
    }
  }

  function finalizeThinkingDuration() {
    if (thinkingStartTime) {
      const thinkingSeg = currentTurnSegments.value.find(s => s.type === 'thinking')
      if (thinkingSeg && thinkingSeg.type === 'thinking') {
        thinkingSeg.duration_ms = Date.now() - thinkingStartTime
      }
      thinkingStartTime = null
    }
  }

  function findToolSegment(tool_use_id: string): ToolCallDisplay | undefined {
    const seg = currentTurnSegments.value.find(
      (s): s is { type: 'tool'; call: ToolCallDisplay } =>
        s.type === 'tool' && s.call.tool_use_id === tool_use_id,
    )
    return seg?.call
  }

  onMounted(async () => {
    if (!isTauri()) return
    unlisten = await onAgentEvent((event: AgentEvent) => {
      if (!sessionId.value || event.session_id !== sessionId.value) return

      switch (event.type) {
        case 'TextDelta': {
          finalizeThinkingDuration()
          if ('source_task_id' in event && event.source_task_id) {
            tabEventHandler?.(event)
            break
          }
          streamingText.value += event.delta
          appendTextToCurrentTurn(event.delta)
          tabEventHandler?.(event)
          break
        }
        case 'ThinkingDelta': {
          if ('source_task_id' in event && event.source_task_id) {
            tabEventHandler?.(event)
            break
          }
          if (!thinkingStartTime) thinkingStartTime = Date.now()
          const segs = currentTurnSegments.value
          const last = segs[segs.length - 1]
          if (last && last.type === 'thinking') {
            last.text += event.delta
          } else {
            segs.push({ type: 'thinking', text: event.delta, duration_ms: 0 })
          }
          tabEventHandler?.(event)
          break
        }
        case 'MessageComplete': {
          if ('source_task_id' in event && event.source_task_id) {
            tabEventHandler?.(event)
            break
          }
          streamingText.value = ''
          tokenUsage.value = {
            inputTokens: event.usage.input_tokens,
            outputTokens: tokenUsage.value.outputTokens + event.usage.output_tokens,
          }
          tabEventHandler?.(event)
          break
        }
        case 'TurnComplete': {
          if ('source_task_id' in event && event.source_task_id) {
            tabEventHandler?.(event)
            break
          }
          finalizeThinkingDuration()
          const persistableSegments = currentTurnSegments.value.filter(s => s.type !== 'thinking')
          if (persistableSegments.length > 0) {
            messages.value.push({
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '',
              segments: [...persistableSegments],
              timestamp: new Date().toISOString(),
            })
          }
          currentTurnSegments.value = []
          thinkingStartTime = null
          isStreaming.value = false
          tabEventHandler?.(event)
          break
        }
        case 'Error': {
          if ('source_task_id' in event && event.source_task_id) {
            tabEventHandler?.(event)
            break
          }
          messages.value.push(createMessage('system', `Error: ${event.message}`))
          isStreaming.value = false
          tabEventHandler?.(event)
          break
        }
        case 'ToolCallStart': {
          finalizeThinkingDuration()
          if ('source_task_id' in event && event.source_task_id) {
            tabEventHandler?.(event)
            break
          }
          currentTurnSegments.value.push({
            type: 'tool',
            call: {
              tool_use_id: event.tool_use_id,
              tool_name: event.tool_name,
              input: event.input,
              status: 'running',
            },
          })
          tabEventHandler?.(event)
          break
        }
        case 'ToolCallEnd': {
          if ('source_task_id' in event && event.source_task_id) {
            tabEventHandler?.(event)
            break
          }
          const tc = findToolSegment(event.tool_use_id)
          if (tc) {
            tc.status = event.is_error ? 'error' : 'completed'
            tc.output = event.output
          }
          tabEventHandler?.(event)
          break
        }
        case 'TaskCreated':
          // 建立 tool_use_id -> task_id 映射
          if (event.tool_use_id) {
            toolUseToTaskId.value.set(event.tool_use_id, event.task_id)
          }
          taskNodes.value.set(event.task_id, {
            type: 'task_node',
            task_id: event.task_id,
            session_id: event.session_id,
            description: event.description,
            status: 'running',
            mode: event.mode as 'preset' | 'fork',
            subagent_type: event.subagent_type,
            budget: { max_tokens: event.budget.max_tokens, max_turns: 0, max_tool_calls: 0 },
            usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
            created_at: new Date().toISOString(),
            completed_at: null,
            output_file: null,
          })
          tabEventHandler?.(event)
          break
        case 'TaskProgress': {
          const node = taskNodes.value.get(event.task_id)
          if (node) node.usage = event.usage
          break
        }
        case 'TaskCompleted': {
          const node = taskNodes.value.get(event.task_id)
          if (node) {
            node.status = event.status as TaskNode['status']
            node.usage = event.usage
            node.completed_at = new Date().toISOString()
          }
          tabEventHandler?.(event)
          break
        }
        case 'BudgetWarning':
          break
        case 'TaskFeedback':
          break
        case 'OrchestrateNodeCreated':
          orchestrateNodes.value.set(event.node_id, {
            type: 'orchestrate_node',
            node_id: event.node_id,
            parent_id: event.parent_id,
            session_id: event.session_id,
            role: event.role as 'orchestrator' | 'executor',
            depth: event.depth,
            description: event.description,
            status: 'running',
            directive: '',
            budget: { max_tokens: 0, max_turns: 0, max_tool_calls: 0 },
            usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
            feedback_history: [],
            reuse_count: 0,
            children_ids: [],
          })
          // 同步父节点的 children_ids
          if (event.parent_id) {
            const parent = orchestrateNodes.value.get(event.parent_id)
            if (parent) parent.children_ids.push(event.node_id)
          }
          tabEventHandler?.(event)
          break
        case 'OrchestrateNodeProgress': {
          const onode = orchestrateNodes.value.get(event.node_id)
          if (onode) onode.usage = event.usage
          break
        }
        case 'OrchestrateNodeCompleted': {
          const onode = orchestrateNodes.value.get(event.node_id)
          if (onode) {
            onode.status = event.status as OrchestrateNode['status']
            onode.usage = event.usage
          }
          tabEventHandler?.(event)
          break
        }
        case 'OrchestrateNodeIdle': {
          const onode = orchestrateNodes.value.get(event.node_id)
          if (onode) onode.status = 'idle'
          break
        }
        case 'OrchestrateFeedback':
          break
      }
    })
  })

  onUnmounted(() => { unlisten?.() })

  async function send(content: string) {
    if (!sessionId.value || isStreaming.value) return
    // 等待进行中的历史加载完成，避免 loadHistory 覆盖即将 push 的用户消息
    if (historyLoadPromise) await historyLoadPromise
    isStreaming.value = true
    messages.value.push(createMessage('user', content))
    currentTurnSegments.value = []
    thinkingStartTime = null
    streamingText.value = ''
    try {
      await sendMessage(sessionId.value, content)
    } catch (err) {
      messages.value.push(createMessage('system', `发送失败: ${err}`))
      isStreaming.value = false
    }
  }

  async function cancel() {
    if (!sessionId.value || !isStreaming.value) return
    // 立即更新 UI 状态，不等待后端 TurnComplete 事件
    finalizeThinkingDuration()
    const persistableSegments = currentTurnSegments.value.filter(s => s.type !== 'thinking')
    if (persistableSegments.length > 0) {
      messages.value.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        segments: [...persistableSegments],
        timestamp: new Date().toISOString(),
      })
    }
    currentTurnSegments.value = []
    thinkingStartTime = null
    isStreaming.value = false
    try {
      await cancelMessage(sessionId.value)
    } catch (err) {
      console.warn('[useChat] cancel failed:', err)
    }
  }

  async function loadHistory(sid: string) {
    const result = await getHistory(sid)
    const msgs: ChatMessage[] = []

    if (result.conversation_summary) {
      msgs.push(createMessage('system', `[对话摘要] ${result.conversation_summary}`))
    }

    msgs.push(...transcriptToMessages(result.entries))

    messages.value = msgs
    result.task_nodes.forEach(n => taskNodes.value.set(n.task_id, n))
    result.orchestrate_nodes.forEach(n => orchestrateNodes.value.set(n.node_id, n))
  }

  watch(sessionId, (newId) => {
    if (newId) {
      historyLoadPromise = loadHistory(newId).finally(() => { historyLoadPromise = null })
    }
  })

  function setTabEventHandler(handler: (event: AgentEvent) => void) {
    tabEventHandler = handler
  }

  return { messages, streamingText, isStreaming, tokenUsage, send, cancel, currentTurnSegments, taskNodes, orchestrateNodes, toolUseToTaskId, setTabEventHandler }
}
