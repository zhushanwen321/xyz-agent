import { useTreeStore } from '../stores/tree'
import { send } from '../lib/ws-client'
import { on } from '../lib/event-bus'
import type { ServerMessage } from '@xyz-agent/shared'

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
    }
    // 成功时 session.history 由 useChat 全局处理器更新消息
  }

  function onTreeForkResult(msg: ServerMessage) {
    const sid = getSid(msg)
    if (!sid) return
    const success = msg.payload.success as boolean
    if (!success) {
      const errMsg = (msg.payload.error as string) ?? 'Fork failed'
      store.setError(sid, errMsg)
    }
    // 成功时 session.list 由 useSession 全局处理器更新
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

// 模块级注册：延后到 Pinia 安装后执行
queueMicrotask(() => registerGlobalListeners())
