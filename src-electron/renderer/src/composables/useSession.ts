import { onMounted, onUnmounted, getCurrentInstance } from 'vue'
import { useSessionStore } from '../stores/session'
import { useChatStore } from '../stores/chat'
import { usePaneStore } from '../stores/pane'
import { send } from '../lib/ws-client'
import { on, off } from '../lib/event-bus'
import type { ServerMessage, SessionSummary, Message } from '@xyz-agent/shared'

// ── 全局事件处理器（ref-counted，解决多组件重复注册问题）───
// useSession 被 App.vue + AppSidebar.vue + EmptyPane.vue 分别调用，
// 每调用一次就注册一套监听器。多个 onSessionRestored 会重复处理 session.restored，
// 导致 addSession 添加多条相同 session → duplicate key 错误。

let globalListenerRefCount = 0
let globalEventMap: Record<string, (msg: ServerMessage) => void> | null = null

function createGlobalHandlers() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  function onSessionList(msg: ServerMessage) {
    const payload = msg.payload as { groups: Array<{ cwd: string; sessions: SessionSummary[] }> }
    const groups = payload.groups
    const all = groups.flatMap(g => g.sessions)
    sessionStore.setSessions(all)
  }

  function onSessionCreated(msg: ServerMessage) {
    const payload = msg.payload as { session: { id: string; label?: string; cwd: string } }
    const session = payload.session
    if (!session) return
    sessionStore.addSession({
      id: session.id,
      label: session.label ?? 'New Session',
      cwd: session.cwd,
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: '',
      tokenCount: 0,
    })
    sessionStore.switchSession(session.id)
  }

  function onSessionDeleted(msg: ServerMessage) {
    sessionStore.removeSession((msg.payload as { sessionId: string }).sessionId)
  }

  function onSessionRestored(msg: ServerMessage) {
    const { oldSessionId, newSessionId, summary } = msg.payload as {
      oldSessionId: string
      newSessionId: string
      summary: SessionSummary
    }
    // Remove old session, add new one, switch to it
    sessionStore.removeSession(oldSessionId)
    sessionStore.addSession(summary)
    sessionStore.switchSession(newSessionId)
    // 关键：更新 paneStore 中所有引用旧 sessionId 的 pane 绑定
    // 否则 PaneSessionView 仍用旧 id，而事件用的是新 id，导致内容不渲染
    const paneStore = usePaneStore()
    const panes = paneStore.panes
    for (const pane of panes) {
      if (pane.sessionId === oldSessionId) {
        paneStore.bindSession(pane.id, newSessionId)
      }
    }
    // 同步 chatStore 数据：把旧 id 分区的数据迁移到新 id
    const oldState = chatStore.getSessionState(oldSessionId)
    if (oldState) {
      chatStore.ensureSession(newSessionId)
      // 迁移 streamingMessage 和 isGenerating
      if (oldState.streamingMessage) {
        chatStore.setStreaming(oldState.streamingMessage, newSessionId)
      }
      if (oldState.isGenerating) {
        chatStore.setGenerating(true, newSessionId)
      }
      // 迁移 completedMessages
      if (oldState.completedMessages.length > 0) {
        chatStore.replaceMessages([...oldState.completedMessages], newSessionId)
      }
      // 清理旧分区（仅在 old !== new 时，restoreSession 复用原始 sessionId）
      if (oldSessionId !== newSessionId) {
        chatStore.removeSession(oldSessionId)
      }
    }
  }

  function onSessionHistory(msg: ServerMessage) {
    const payload = msg.payload as { sessionId?: string; messages?: Message[] }
    const sessionId = payload.sessionId ?? sessionStore.currentSessionId ?? '__default__'
    const messages = payload.messages ?? []
    chatStore.replaceMessages(messages, sessionId)
  }

  return {
    'session.list': onSessionList,
    'session.created': onSessionCreated,
    'session.deleted': onSessionDeleted,
    'session.restored': onSessionRestored,
    'session.history': onSessionHistory,
  } as Record<string, (msg: ServerMessage) => void>
}

function registerGlobalListeners() {
  if (globalEventMap) return
  globalEventMap = createGlobalHandlers()
  for (const [evt, handler] of Object.entries(globalEventMap)) {
    on(evt, handler)
  }
}

function unregisterGlobalListeners() {
  if (!globalEventMap) return
  for (const [evt, handler] of Object.entries(globalEventMap)) {
    off(evt, handler)
  }
  globalEventMap = null
}

export function useSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  function loadSessions() {
    send({ type: 'session.list', payload: {} })
  }

  function createSession(cwd: string, label?: string) {
    send({ type: 'session.create', payload: { cwd, label } })
  }

  function deleteSession(sessionId: string) {
    send({ type: 'session.delete', payload: { sessionId } })
  }

  function switchSession(sessionId: string) {
    sessionStore.switchSession(sessionId)
    chatStore.ensureSession(sessionId)
    send({ type: 'session.history', payload: { sessionId } })
  }

  function compactSession() {
    const sid = sessionStore.currentSessionId
    if (!sid) return
    send({ type: 'session.compact', payload: { sessionId: sid } })
  }

  function clearSession() {
    const sid = sessionStore.currentSessionId
    if (!sid) return
    send({ type: 'session.clear', payload: { sessionId: sid } })
  }

  // 全局事件 listener 生命周期：第一个组件 mounted 时注册，最后一个 unmounted 时注销
  if (getCurrentInstance()) {
    onMounted(() => {
      if (globalListenerRefCount === 0) {
        registerGlobalListeners()
      }
      globalListenerRefCount++
    })

    onUnmounted(() => {
      globalListenerRefCount--
      if (globalListenerRefCount === 0) {
        unregisterGlobalListeners()
      }
    })
  }

  return { loadSessions, createSession, deleteSession, switchSession, compactSession, clearSession }
}
