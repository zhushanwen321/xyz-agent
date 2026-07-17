/**
 * Sidebar subagent/workflow 操作 handler 集合（从 Sidebar.vue 提取，减行用）。
 *
 * 职责：subagent select/cancel + workflow select/back/action/agentCall 的事件处理。
 * 跨 store 编排（chatStore 注入）在此层完成（铁律：store 不 import chatStore）。
 */
import type { Ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { usePanelStore } from '@/stores/panel'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import * as sessionApi from '@/api/domains/session'

export function useSidebarSubagentActions(focusedSessionId: Ref<string | null>) {
  const { t } = useI18n()
  const { error: toastError } = useToast()
  const panelStore = usePanelStore()
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  /** 选中 subagent → active panel overlay 视图（chatStore streaming 回调注入） */
  async function onSelectSubagent(subagentId: string): Promise<void> {
    const activePanel = panelStore.panels.find((p) => p.id === panelStore.activePanelId)
    if (!activePanel?.sessionId) return
    const chat = useChatStore()
    try {
      await subagentStore.selectSubagent(
        panelStore.activePanelId,
        activePanel.sessionId,
        subagentId,
        (virtualId, lines) => chat.applySubagentStreamDelta(virtualId, lines),
        (virtualId) => chat.finalizeSubagentStream(virtualId),
        (virtualId, msgs) => chat.setMessages(virtualId, msgs),
      )
    } catch (e) {
      // [M7] catch 回滚：selectSubagent 失败时 backToMain 清理（幂等，messages 可能未注入）
      subagentStore.backToMain(
        panelStore.activePanelId,
        activePanel.sessionId,
        subagentId,
        (sid) => chat.evictSessionWithVirtual(sid),
      )
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.loadSubagentFailed', { msg }))
    }
  }

  /** 取消 running subagent（调 RPC + 乐观更新，失败 toast） */
  async function onCancelSubagent(subagentId: string): Promise<void> {
    const sid = focusedSessionId.value
    if (!sid) return
    try {
      await subagentStore.cancelSubagent(sid, subagentId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.cancelSubagentFailed', { msg }))
    }
  }

  /** 选中 workflow → 视图 2 详情（sidebar 内，不切 Panel） */
  function onSelectWorkflow(runId: string): void {
    workflowStore.selectWorkflow(panelStore.activePanelId, runId)
  }

  /** 视图 2 → 视图 1（返回 workflow 列表） */
  function onWorkflowBack(): void {
    workflowStore.backToWorkflowList(panelStore.activePanelId)
  }

  /** 选中 agent call → Panel overlay（Fail-fast：失败回滚 + toast） */
  async function onSelectAgentCall(agentCallSessionId: string | undefined): Promise<void> {
    if (!agentCallSessionId) {
      toastError(t('sidebar.agentCallFailed'))
      return
    }
    const activePanel = panelStore.panels.find((p) => p.id === panelStore.activePanelId)
    if (!activePanel?.sessionId) return
    const chat = useChatStore()
    try {
      await workflowStore.selectAgentCall(
        panelStore.activePanelId,
        activePanel.sessionId,
        agentCallSessionId,
        (virtualId, msgs) => chat.setMessages(virtualId, msgs),
      )
    } catch (e) {
      // [M7] catch 回滚：backFromAgentCall 清理（幂等，messages 可能未注入）
      workflowStore.backFromAgentCall(panelStore.activePanelId, (acsId) => chat.evictSessionWithVirtual(acsId))
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.agentCallLoadFailed', { msg }))
    }
  }

  /** workflow 操作（pause/resume/abort），调 runtime RPC + 刷新列表 */
  async function onWorkflowAction(payload: { action: 'pause' | 'resume' | 'abort'; runId: string }): Promise<void> {
    const sid = focusedSessionId.value
    if (!sid) return
    try {
      await sessionApi.workflowAction(sid, payload.action, payload.runId)
      void workflowStore.loadWorkflows(sid)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toastError(t('sidebar.workflowOpFailed', { msg }))
    }
  }

  return {
    onSelectSubagent,
    onCancelSubagent,
    onSelectWorkflow,
    onWorkflowBack,
    onSelectAgentCall,
    onWorkflowAction,
  }
}
