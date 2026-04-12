import { ref, computed, watch, type Ref } from 'vue'
import type { ChatTab, TabStatus, AgentEvent, ChatMessage, AssistantSegment } from '../types'
import { transcriptToMessages } from '../lib/transcript'
import { loadSidechainHistory, isTauri } from '../lib/tauri'

interface SessionTabData {
  tabs: ChatTab[]
  activeTabId: string
  tabMessages: Map<string, ChatMessage[]>
}

const sessionStore = new Map<string, SessionTabData>()

function getSession(sid: string): SessionTabData | undefined {
  return sessionStore.get(sid)
}

function getOrCreateSession(sid: string): SessionTabData {
  let data = sessionStore.get(sid)
  if (!data) {
    data = { tabs: [], activeTabId: 'main', tabMessages: new Map() }
    sessionStore.set(sid, data)
  }
  return data
}

/** 删除 session 时清理对应 Tab 数据，防止内存泄漏 */
export function clearSessionTabs(sid: string) {
  sessionStore.delete(sid)
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

  /** 触发 tabMessages ref 更新（让 Vue 检测到 Map 变化） */
  function syncTabMessages(data: SessionTabData) {
    tabMessages.value = new Map(data.tabMessages)
  }

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
    }
    data.activeTabId = 'main'
    activeTabId.value = 'main'
  }

  function openSubAgentTab(tabId: string, title: string, sid: string, type: 'subagent' | 'orchestrate') {
    const data = getOrCreateSession(sid)
    if (data.tabs.find(t => t.id === tabId)) {
      data.activeTabId = tabId
      activeTabId.value = tabId
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
    activeTabId.value = tabId
    loadTabHistory(sid, tabId, type)
  }

  async function loadTabHistory(sid: string, tabId: string, tabType: 'subagent' | 'orchestrate') {
    if (!isTauri()) return
    try {
      const data = getOrCreateSession(sid)
      const entries = await loadSidechainHistory(
        sid, tabId, tabType === 'subagent' ? 'subagent' : 'orchestrate'
      )
      data.tabMessages.set(tabId, transcriptToMessages(entries))
      syncTabMessages(data)
    } catch (err) {
      console.warn('[useTabManager] loadTabHistory failed:', err)
    }
  }

  function closeTab(tabId: string) {
    if (tabId === 'main') return
    const sid = sessionId.value
    if (!sid) return
    const data = getSession(sid)
    if (!data) return
    const idx = data.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return
    data.tabs.splice(idx, 1)
    data.tabMessages.delete(tabId)
    if (data.activeTabId === tabId) {
      data.activeTabId = 'main'
      activeTabId.value = 'main'
    }
  }

  function switchTab(tabId: string) {
    const sid = sessionId.value
    if (!sid) return
    const data = getSession(sid)
    if (!data) return
    if (data.tabs.find(t => t.id === tabId)) {
      data.activeTabId = tabId
      activeTabId.value = tabId
    }
  }

  function updateTabStatus(tabId: string, status: TabStatus) {
    const sid = sessionId.value
    if (!sid) return
    const data = getSession(sid)
    if (!data) return
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

  /** 将带 source_task_id 的实时事件直接追加到 Tab 的 messages 中（就地修改，避免每帧 O(n) 复制） */
  function appendTabEvent(tabId: string, event: AgentEvent) {
    const sid = sessionId.value
    if (!sid) return
    const data = getOrCreateSession(sid)
    let msgs = data.tabMessages.get(tabId)
    if (!msgs) {
      msgs = []
      data.tabMessages.set(tabId, msgs)
    }

    switch (event.type) {
      case 'TextDelta':
      case 'ThinkingDelta': {
        const delta = event.delta
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
        if (last?.role === 'assistant' && last.isStreaming) {
          const segs = last.segments ?? []
          const lastSeg = segs[segs.length - 1]
          if (lastSeg?.type === 'text') {
            lastSeg.text += delta
          } else {
            segs.push({ type: 'text', text: delta })
          }
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
          (last.segments ?? []).push(toolSeg)
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
          const segs = last.segments ?? []
          const toolSeg = segs.find(
            (s): s is AssistantSegment & { type: 'tool' } =>
              s.type === 'tool' && s.call.tool_use_id === event.tool_use_id,
          )
          if (toolSeg) {
            toolSeg.call.status = event.is_error ? 'error' : 'completed'
            toolSeg.call.output = event.output
          }
        }
        break
      }
      case 'TurnComplete':
      case 'MessageComplete': {
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
        if (last?.isStreaming) {
          last.isStreaming = false
        }
        break
      }
    }

    // 批量事件后触发一次 ref 更新（调用方在每个事件后都调用，但 Map replace 很轻量）
    syncTabMessages(data)
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
