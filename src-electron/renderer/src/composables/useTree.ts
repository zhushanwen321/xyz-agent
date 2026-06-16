import { useTreeStore } from '../stores/tree'
import { api } from '../api'
import { ref } from 'vue'
import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

// ── 常量 ────────────────────────────────────────────────────────
const TREE_FETCH_TIMEOUT_MS = 10_000

// ── 全局状态 ──────────────────────────────────────────────────

/** Navigate 后的 editorText，按 session 存储，避免 split mode 交叉污染 */
const pendingEditorTexts = new Map<string, string>()

/** pending editor text 的变更版本号：每次 set 自增，供 ChatInput watch 响应（替代 event-bus 通知） */
const pendingEditorVersion = ref(0)

export function consumePendingEditorText(sessionId: string): string | null {
  const text = pendingEditorTexts.get(sessionId) ?? null
  pendingEditorTexts.delete(sessionId)
  return text
}

export function getPendingEditorVersion() {
  return pendingEditorVersion
}

// ── 全局事件处理器 ────────────────────────────────────────────────

function createGlobalHandlers() {
  const store = useTreeStore()

  function getSid(msg: ServerMessage): string | null {
    return (msg.payload?.sessionId as string) ?? null
  }

  function onTreeData(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    // 服务器返回的错误
    const errMsg = msg.payload.error as string | undefined
    if (errMsg) {
      store.setError(sid, errMsg)
      store.setLoading(sid, false)
      return
    }
    const tree = (msg.payload.tree as Array<import('../stores/tree').TreeNode>) ?? []
    const leafId = (msg.payload.leafId as string | null) ?? null
    const navigateCapable = (msg.payload.navigateCapable as boolean) ?? false
    const branchCount = (msg.payload.branchCount as number) ?? 0
    store.setTreeData(sid, { tree, leafId, navigateCapable, branchCount })
  }

  function onTreeNavigateResult(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const success = msg.payload.success as boolean
    if (!success) {
      const errMsg = (msg.payload.error as string) ?? 'Navigate failed'
      store.setError(sid, errMsg)
      store.setLoading(sid, false)
      return
    }
    // Navigate 成功：直接设置 leafId（不等服务端 tree-data），然后刷新消息和 tree 结构
    store.clearError(sid)
    store.selectNode(sid, null)
    // 服务端回传 newLeafId（即 targetEntryId），前端直接设为 active path 的 leaf
    const newLeafId = msg.payload.newLeafId as string | undefined
    if (newLeafId) {
      store.setLeafId(sid, newLeafId)
    }
    api.session.history({ sessionId: sid })
    api.tree.data({ sessionId: sid })
    // 预填 editorText（navigate 到 user message 时的原始文本）
    const editorText = msg.payload.editorText as string | undefined
    if (editorText) {
      pendingEditorTexts.set(sid, editorText)
      pendingEditorVersion.value++
    }
  }

  function onTreeForkResult(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const success = msg.payload.success as boolean
    if (!success) {
      const errMsg = (msg.payload.error as string) ?? 'Fork failed'
      store.setError(sid, errMsg)
      store.setLoading(sid, false)
      return
    }
    // Fork 成功：重置 loading + 关闭面板 + 刷新 session 列表 + 切换到新 session
    store.setLoading(sid, false)
    store.setPanelOpen(sid, false)
    const newSessionId = msg.payload.newSessionId as string | undefined
    if (newSessionId) {
      api.session.list()
      api.session.switch({ sessionId: newSessionId })
    }
  }

  function onTreeCloneResult(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const success = msg.payload.success as boolean
    if (!success) {
      const errMsg = (msg.payload.error as string) ?? 'Clone failed'
      store.setError(sid, errMsg)
      return
    }
    // Clone 成功：刷新 session 列表 + 自动切换到新 session
    const newSessionId = msg.payload.newSessionId as string | undefined
    if (newSessionId) {
      api.session.list()
      api.session.switch({ sessionId: newSessionId })
    }
  }

  function onTreeCapability(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const navigateCapable = (msg.payload.navigateCapable as boolean) ?? false
    store.setNavigateCapable(sid, navigateCapable)
  }

  return new Map<ServerMessageType, (msg: ServerMessage) => void>([
    ['session.tree-data', onTreeData],
    ['session.tree-navigate-result', onTreeNavigateResult],
    ['session.tree-fork-result', onTreeForkResult],
    ['session.tree-clone-result', onTreeCloneResult],
    ['session.tree-capability', onTreeCapability],
  ])
}

let globalEventMap: Map<ServerMessageType, (msg: ServerMessage) => void> | null = null

function registerGlobalListeners() {
  if (globalEventMap) return
  globalEventMap = createGlobalHandlers()
  for (const [evt, handler] of globalEventMap) {
    api.events.on(evt, handler)
  }
}

// ── useTree composable ─────────────────────────────────────────────

/**
 * Tree composable — 提供树操作的命令发送函数。
 *
 * 事件处理已全局化（从消息 payload 提取 sessionId 路由到 TreeStore 分区）。
 * 组件按需调用命令函数即可。
 */
export function useTree() {
  const store = useTreeStore()

  function fetchTree(sessionId: string) {
    store.setLoading(sessionId, true)
    api.tree.data({ sessionId })
    // 超时保护：10s 内未收到 tree-data 响应则重置 loading，避免 UI 永久卡死
    setTimeout(() => {
      const state = store.getSessionState(sessionId)
      if (state.isLoading) {
        store.setLoading(sessionId, false)
        store.setError(sessionId, 'Tree data request timed out')
      }
    }, TREE_FETCH_TIMEOUT_MS)
  }

  function navigate(sessionId: string, targetEntryId: string) {
    store.setLoading(sessionId, true)
    api.tree.navigate({ sessionId, targetEntryId })
  }

  function fork(sessionId: string, entryId: string) {
    store.setLoading(sessionId, true)
    api.tree.fork({ sessionId, entryId })
  }

  function requestCapability(sessionId: string) {
    api.tree.capability({ sessionId })
  }

  function cloneSession(sessionId: string) {
    api.tree.clone({ sessionId })
  }

  return { fetchTree, navigate, fork, requestCapability, cloneSession }
}

// 模块级注册：延后到 Pinia 安装后执行，测试环境可能 Pinia 未安装则静默跳过
let treeRegisterAttempted = false
function safeRegisterTreeListeners() {
  if (globalEventMap || treeRegisterAttempted) return
  try {
    registerGlobalListeners()
    treeRegisterAttempted = true  // 成功后才标记，允许重试
  // eslint-disable-next-line taste/no-silent-catch
  } catch (e) {
    // Pinia 未就绪（测试环境），不标记 attempted，允许后续重试
    console.debug('[useTree] Tree listeners registration deferred (Pinia not ready):', e)
  }
}
queueMicrotask(safeRegisterTreeListeners)
