import { ref, computed, watch, type Ref } from 'vue'
import type {
  ChatTab, TabStatus, AgentEvent, ChatMessage, AssistantSegment,
  TranscriptEntry, UserContentBlock, AssistantContentBlock,
} from '../types'
import { loadSidechainHistory, isTauri } from '../lib/tauri'

// 每个 session 维护独立的 Tab 数据（普通对象，不用嵌套 Ref）
interface SessionTabData {
  tabs: ChatTab[]
  activeTabId: string
  tabMessages: Map<string, ChatMessage[]>
}

const sessionStore = new Map<string, SessionTabData>()

function getOrCreateSession(sid: string): SessionTabData {
  let data = sessionStore.get(sid)
  if (!data) {
    data = { tabs: [], activeTabId: 'main', tabMessages: new Map() }
    sessionStore.set(sid, data)
  }
  return data
}

export function useTabManager(sessionId: Ref<string | null>) {
  const tabs = ref<ChatTab[]>([])
  const activeTabId = ref('main')
  const tabMessages = ref<Map<string, ChatMessage[]>>(new Map())

  // session 切换时加载对应数据
  watch(sessionId, (newId) => {
    if (!newId) return
    const data = getOrCreateSession(newId)
    tabs.value = data.tabs
    activeTabId.value = data.activeTabId
    tabMessages.value = data.tabMessages
  }, { immediate: true })

  const activeTab = computed(() =>
    tabs.value.find(t => t.id === activeTabId.value)
  )

  function ensureMainTab(sid: string) {
    const data = getOrCreateSession(sid)
    if (!data.tabs.find(t => t.id === 'main')) {
      data.tabs.unshift({
        id: 'main',
        type: 'main',
        title: 'Main Agent',
        session_id: sid,
        status: 'idle',
        closable: false,
      })
      data.activeTabId = 'main'
    }
  }

  function openSubAgentTab(tabId: string, title: string, sid: string, type: 'subagent' | 'orchestrate') {
    const data = getOrCreateSession(sid)
    if (data.tabs.find(t => t.id === tabId)) {
      data.activeTabId = tabId
      return
    }
    data.tabs.push({
      id: tabId,
      type,
      title,
      session_id: sid,
      sidechain_id: tabId,
      status: 'idle',
      closable: true,
    })
    data.activeTabId = tabId
    loadTabHistory(sid, tabId, type)
  }

  async function loadTabHistory(sid: string, tabId: string, tabType: 'subagent' | 'orchestrate') {
    if (!isTauri()) return
    const data = getOrCreateSession(sid)
    const entries = await loadSidechainHistory(
      sid, tabId, tabType === 'subagent' ? 'subagent' : 'orchestrate'
    )
    data.tabMessages.set(tabId, entriesToMessages(entries))
  }

  function closeTab(tabId: string) {
    if (tabId === 'main') return
    const sid = sessionId.value
    if (!sid) return
    const data = getOrCreateSession(sid)
    const idx = data.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return
    data.tabs.splice(idx, 1)
    data.tabMessages.delete(tabId)
    if (data.activeTabId === tabId) {
      data.activeTabId = 'main'
    }
  }

  function switchTab(tabId: string) {
    const sid = sessionId.value
    if (!sid) return
    const data = getOrCreateSession(sid)
    if (data.tabs.find(t => t.id === tabId)) {
      data.activeTabId = tabId
    }
  }

  function updateTabStatus(tabId: string, status: TabStatus) {
    const sid = sessionId.value
    if (!sid) return
    const data = getOrCreateSession(sid)
    const tab = data.tabs.find(t => t.id === tabId)
    if (tab) tab.status = status
  }

  function eventToTabStatus(event: AgentEvent): TabStatus | null {
    switch (event.type) {
      case 'TextDelta':
      case 'ThinkingDelta': return 'streaming'
      case 'ToolCallStart': return 'tool'
      case 'ToolCallEnd': return 'streaming'
      case 'TurnComplete': return 'completed'
      case 'Error': return 'failed'
      case 'TaskCompleted': return 'completed'
      case 'OrchestrateNodeCompleted': return 'completed'
      default: return null
    }
  }

  function entriesToMessages(entries: TranscriptEntry[]): ChatMessage[] {
    const msgs: ChatMessage[] = []
    const toolOutputs = new Map<string, { output: string; is_error: boolean }>()
    for (const entry of entries) {
      if (entry.type === 'user') {
        for (const block of entry.content as UserContentBlock[]) {
          if (block.type === 'tool_result') {
            toolOutputs.set(block.tool_use_id, { output: block.content, is_error: block.is_error })
          }
        }
      }
    }
    for (const entry of entries) {
      if (entry.type === 'user') {
        const blocks = entry.content as UserContentBlock[]
        const hasText = blocks.some(b => b.type === 'text')
        if (!hasText) continue
        const text = blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text).join('')
        msgs.push({ id: entry.uuid, role: 'user', content: text, timestamp: entry.timestamp })
      } else if (entry.type === 'assistant') {
        const blocks = entry.content as AssistantContentBlock[]
        const segments: AssistantSegment[] = blocks.map(b => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text }
          const result = toolOutputs.get(b.id)
          return {
            type: 'tool' as const,
            call: {
              tool_use_id: b.id,
              tool_name: b.name,
              input: b.input,
              status: result ? (result.is_error ? 'error' as const : 'completed' as const) : 'completed' as const,
              output: result?.output,
            },
          }
        })
        msgs.push({ id: entry.uuid, role: 'assistant', content: '', segments, timestamp: entry.timestamp })
      }
    }
    return msgs
  }

  function appendTabEvent(tabId: string, event: AgentEvent) {
    const sid = sessionId.value
    if (!sid) return
    const data = getOrCreateSession(sid)
    let msgs = [...(data.tabMessages.get(tabId) ?? [])]

    switch (event.type) {
      case 'TextDelta':
      case 'ThinkingDelta': {
        const delta = event.delta
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
        if (last?.role === 'assistant' && last.isStreaming) {
          const segs = [...(last.segments ?? [])]
          const lastSeg = segs[segs.length - 1]
          if (lastSeg?.type === 'text') {
            segs[segs.length - 1] = { ...lastSeg, text: lastSeg.text + delta }
          } else {
            segs.push({ type: 'text', text: delta })
          }
          msgs[msgs.length - 1] = { ...last, segments: segs }
        } else {
          msgs.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            segments: [{ type: 'text', text: delta }],
            timestamp: new Date().toISOString(),
            isStreaming: true,
          })
        }
        break
      }
      case 'ToolCallStart': {
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
        const toolSeg: AssistantSegment = {
          type: 'tool',
          call: {
            tool_use_id: event.tool_use_id,
            tool_name: event.tool_name,
            input: event.input,
            status: 'running',
          },
        }
        if (last?.role === 'assistant' && last.isStreaming) {
          msgs[msgs.length - 1] = {
            ...last,
            segments: [...(last.segments ?? []), toolSeg],
          }
        } else {
          msgs.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            segments: [toolSeg],
            timestamp: new Date().toISOString(),
            isStreaming: true,
          })
        }
        break
      }
      case 'ToolCallEnd': {
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
        if (last?.role === 'assistant' && last.isStreaming) {
          const segs = [...(last.segments ?? [])]
          const toolSeg = segs.find(
            (s): s is AssistantSegment & { type: 'tool' } =>
              s.type === 'tool' && s.call.tool_use_id === event.tool_use_id,
          )
          if (toolSeg) {
            toolSeg.call = {
              ...toolSeg.call,
              status: event.is_error ? 'error' : 'completed',
              output: event.output,
            }
            msgs[msgs.length - 1] = { ...last, segments: segs }
          }
        }
        break
      }
      case 'TurnComplete':
      case 'MessageComplete': {
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
        if (last?.isStreaming) {
          msgs[msgs.length - 1] = { ...last, isStreaming: false }
        }
        break
      }
    }

    data.tabMessages.set(tabId, msgs)
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    tabMessages,
    ensureMainTab,
    openSubAgentTab,
    closeTab,
    switchTab,
    updateTabStatus,
    eventToTabStatus,
    appendTabEvent,
  }
}
