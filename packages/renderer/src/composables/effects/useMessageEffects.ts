/**
 * useMessageEffects —— useConnection 的入站副作用回调实现（架构审计 §11.4）。
 *
 * core use-connection 是 headless（零 store / 零 DOM），入站消息的副作用回调
 * （session.exited / message.complete / session.subagents / session.workflowUpdate /
 * 全局 error）与 runtime 崩溃清理（finalizeAllStreaming / clearAllPending）统一归位到本层。
 *
 * 本文件是 renderer 层（可 import store），供 useConnection 装配点经
 * setConnectionPorts 注入 core（ConnectionPorts.effects / onRuntimeUnavailable）。
 *
 * 依赖方向：useMessageEffects → stores + useCompletionNotify + i18n + useToast。
 */
import i18n from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { usePanelStore } from '@/stores/panel'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { handleCompletion } from '@/composables/effects/useCompletionNotify'
import type { InboundEffects } from '@xyz-agent/core'
import type { SubagentRecord } from '@xyz-agent/shared'

const t = i18n.global.t

/**
 * 处理 session.exited 事件（pi 进程异常退出）。
 *
 * 不能只依赖 session 通道的惰性订阅（ensureStreamSubscription 在首次 send 时建立）：
 * 进程可能在用户首次发消息前就死（如 extension 加载失败 exit(1)），此时无订阅者，
 * dispatchSession 会静默丢弃。因此 routeInbound 对 session.exited 做兜底处理，
 * 保证 markSessionError + markDead + toast 一定执行。
 */
function handleSessionExited(sessionId: string, payload: { code: number | null; reason: string }): void {
  useChatStore().markSessionError(sessionId, payload.reason)
  useSessionStore().markDead(sessionId)
  // reason 可能含多行 stderr，toast 只取首行（完整内容在聊天流 error 消息里）
  const shortReason = payload.reason.split('\n')[0]
  useToast().error(t('connection.runtimeExited', { reason: shortReason }))
}

/**
 * 处理 message.complete 事件（session 生成完成）。
 * 算 focusedSid（当前面板聚焦的 session）→ 交给 handleCompletion 链
 * （aborted 过滤 → background work 守卫 → 后台判定 → 未读标记 → 提示音）。
 */
function handleMessageComplete(sessionId: string, payload: { sessionId?: string; stopReason?: string }): void {
  const panelStore = usePanelStore()
  const focusedSid =
    panelStore.panels.find((p) => p.id === panelStore.activePanelId)?.sessionId ?? null
  handleCompletion(sessionId, payload.stopReason ?? 'stop', focusedSid)
}

/** 处理 session.subagents 事件（subagent 终态推送兜底，非活跃 session 也生效）。 */
function handleSubagents(sessionId: string, subagents: SubagentRecord[]): void {
  useSubagentStore().applyRecords(sessionId, subagents)
}

/** 处理 session.workflowUpdate 事件（workflow 增量信号兜底）。 */
function handleWorkflowUpdate(sessionId: string, update: { status?: string }): void {
  useWorkflowStore().triggerWorkflowReload(sessionId, update.status ?? 'unknown')
}

/** 全局 error 兜底（无 sessionId 无 id 的 server-push error → toast 提示）。 */
function handleGlobalError(message: string): void {
  useToast().error(message)
}

/**
 * runtime 崩溃 / 重启用尽清理（T5）。
 *
 * runtime 崩溃 = pi 子进程没了 = 流不可能继续。重置 chat 活跃态 + 清理 extension UI
 * pending，避免 UI 卡「思考中」+ in-flight Promise 永挂（runtime 重启后是全新实例，
 * ask-user 的 Promise 永远不会被 resolve）。
 *
 * @param reason 'restart'（崩溃重启中）/ 'disconnect'（重启用尽，FinalizeReason）
 */
export function handleRuntimeUnavailable(reason: 'restart' | 'disconnect'): void {
  useChatStore().finalizeAllStreaming(reason)
  useExtensionUIStore().clearAllPending()
}

/**
 * 工厂：构建 InboundEffects 回调集（供 useConnection 装配点注入 core）。
 * 函数引用稳定（模块级定义），重复调用返回同一组行为。
 */
export function createInboundEffects(): InboundEffects {
  return {
    onSessionExited: handleSessionExited,
    onMessageComplete: handleMessageComplete,
    onSubagents: handleSubagents,
    onWorkflowUpdate: handleWorkflowUpdate,
    onGlobalError: handleGlobalError,
  }
}
