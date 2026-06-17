import { onMounted, onUnmounted, getCurrentInstance } from 'vue'
import { useSessionStore } from '../stores/session'
import { useChatStore } from '../stores/chat'
import { useTreeStore } from '../stores/tree'
import { api } from '../api'
import type { ServerMessage, ServerMessageType, SessionSummary, Message } from '@xyz-agent/shared'

// ── 全局事件处理器（ref-counted，解决多组件重复注册问题）───
// useSession 被 App.vue + AppSidebar.vue + EmptyPanel.vue 分别调用，
// 每调用一次就注册一套监听器。多个 onSessionCreated 会重复处理 session.created，
// 导致 addSession 添加多条相同 session → duplicate key 错误。

let globalListenerRefCount = 0
let globalEventMap: Map<ServerMessageType, (msg: ServerMessage) => void> | null = null
let globalOffs: Array<() => void> = []

function createGlobalHandlers() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  function onSessionList(msg: ServerMessage) {
    const payload = msg.payload as { groups: Array<{ cwd: string; sessions: SessionSummary[] }> }
    const groups = payload.groups
    const all = groups.flatMap(g => g.sessions)
    sessionStore.setSessions(all)
    // Sync thinkingLevel from server summaries into per-session chat state
    // undefined thinkingLevel means 'off' — ensure frontend clears stale values
    for (const s of all) {
      chatStore.setThinkingLevel(s.thinkingLevel ?? 'off', s.id)
    }
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
    const sid = (msg.payload as { sessionId: string }).sessionId
    sessionStore.removeSession(sid)
    useTreeStore().removeSession(sid)
  }

  function onSessionHistory(msg: ServerMessage) {
    const payload = msg.payload as { sessionId?: string; messages?: Message[] }
    const sessionId = payload.sessionId ?? sessionStore.currentSessionId ?? '__default__'
    const messages = payload.messages ?? []
    chatStore.replaceMessages(messages, sessionId)
  }

  return new Map<ServerMessageType, (msg: ServerMessage) => void>([
    ['session.list', onSessionList],
    ['session.created', onSessionCreated],
    ['session.deleted', onSessionDeleted],
    ['session.history', onSessionHistory],
  ])
}

function registerGlobalListeners() {
  if (globalEventMap) return
  globalEventMap = createGlobalHandlers()
  globalOffs = []
  for (const [evt, handler] of globalEventMap) {
    globalOffs.push(api.events.on(evt, handler))
  }
}

function unregisterGlobalListeners() {
  if (!globalEventMap) return
  for (const off of globalOffs) off()
  globalOffs = []
  globalEventMap = null
}

export function useSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  function loadSessions() {
    api.session.list()
  }

  // 命令响应被 pending.ts 的 id-matched resolver 消费，不会到达 events._dispatch，
  // 因此不能依赖 session.created 事件处理，必须用返回值直接入 store。
  async function createSession(cwd: string, label?: string) {
    const res = (await api.session.create({ cwd, label })) as { session: SessionSummary }
    sessionStore.addSession(res.session)
    sessionStore.switchSession(res.session.id)
  }

  function deleteSession(sessionId: string) {
    api.session.delete({ sessionId })
  }

  async function switchSession(sessionId: string) {
    sessionStore.switchSession(sessionId)
    chatStore.ensureSession(sessionId)
    chatStore.setLoadingHistory(true, sessionId)
    // session.history: 对活跃 session 通过 RPC 获取 history，
    // 对非活跃 session 从磁盘文件读取。更可靠的路径——
    // session.switch 会因 session 在内存 Map 中（驻留但 pi 进程已退出）
    // 而跳过 auto-restore，导致 RPC 调用到死进程返回空历史。
    // 命令响应被 pending.ts 按 id 结算（不经过 events._dispatch），
    // 必须用返回值直接入 store，否则 onSessionHistory 永不触发。
    const res = (await api.session.history({ sessionId })) as { sessionId: string; messages: Message[] }
    chatStore.replaceMessages(res.messages, sessionId)
  }

  function compactSession(sessionId?: string) {
    const sid = sessionId ?? sessionStore.currentSessionId
    if (!sid) return
    api.session.compact({ sessionId: sid })
  }

  function renameSession(sessionId: string, newName: string) {
    api.session.rename({ sessionId, name: newName })
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

  return { loadSessions, createSession, deleteSession, switchSession, compactSession, renameSession }
}
