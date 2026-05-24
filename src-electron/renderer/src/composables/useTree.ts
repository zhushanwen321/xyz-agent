import { useTreeStore } from '../stores/tree'
import { send } from '../lib/ws-client'
import { on, emit } from '../lib/event-bus'
import type { ServerMessage } from '@xyz-agent/shared'

// ── 全局状态 ──────────────────────────────────────────────────

/** Navigate 后的 editorText，按 session 存储，避免 split mode 交叉污染 */
const pendingEditorTexts = new Map<string, string>()

export function consumePendingEditorText(sessionId: string): string | null {
  const text = pendingEditorTexts.get(sessionId) ?? null
  pendingEditorTexts.delete(sessionId)
  return text
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
      return
    }
    // Navigate 成功：刷新消息历史 + tree 数据
    send({ type: 'session.history', payload: { sessionId: sid } })
    send({ type: 'session.tree-data', payload: { sessionId: sid } })
    // 预填 editorText（navigate 到 user message 时的原始文本）
    const editorText = msg.payload.editorText as string | undefined
    if (editorText) {
      pendingEditorTexts.set(sid, editorText)
      emit('editor-text-pending')
    }
  }

  function onTreeForkResult(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const success = msg.payload.success as boolean
    if (!success) {
      const errMsg = (msg.payload.error as string) ?? 'Fork failed'
      store.setError(sid, errMsg)
      return
    }
    // Fork 成功：刷新 session 列表 + 自动切换到新 session
    const newSessionId = msg.payload.newSessionId as string | undefined
    if (newSessionId) {
      send({ type: 'session.list', payload: {} })
      send({ type: 'session.switch', payload: { sessionId: newSessionId } })
    }
  }

  function onTreeCapability(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const navigateCapable = (msg.payload.navigateCapable as boolean) ?? false
    store.setNavigateCapable(sid, navigateCapable)
  }

  return {
    'session.tree-data': onTreeData,
    'session.tree-navigate-result': onTreeNavigateResult,
    'session.tree-fork-result': onTreeForkResult,
    'session.tree-capability': onTreeCapability,
  } as Record<string, (msg: ServerMessage) => void>
}

let globalEventMap: Record<string, (msg: ServerMessage) => void> | null = null

function registerGlobalListeners() {
  if (globalEventMap) return
  globalEventMap = createGlobalHandlers()
  for (const [evt, handler] of Object.entries(globalEventMap)) {
    on(evt, handler)
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
    send({ type: 'session.tree-data', payload: { sessionId } })
  }

  function navigate(sessionId: string, targetEntryId: string) {
    send({ type: 'session.tree-navigate', payload: { sessionId, targetEntryId } })
  }

  function fork(sessionId: string, entryId: string) {
    send({ type: 'session.tree-fork', payload: { sessionId, entryId } })
  }

  function requestCapability(sessionId: string) {
    send({ type: 'session.tree-capability', payload: { sessionId } })
  }

  return { fetchTree, navigate, fork, requestCapability }
}

// 模块级注册：延后到 Pinia 安装后执行，测试环境可能 Pinia 未安装则静默跳过
let treeRegisterAttempted = false
function safeRegisterTreeListeners() {
  if (globalEventMap || treeRegisterAttempted) return
  treeRegisterAttempted = true
  try {
    registerGlobalListeners()
  } catch {
    // Pinia 未就绪（测试环境），静默跳过
  }
}
queueMicrotask(safeRegisterTreeListeners)
