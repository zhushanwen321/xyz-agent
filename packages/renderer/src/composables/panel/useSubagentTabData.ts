/**
 * SubagentTab 对话流数据编排（chat store ops 面消费收口，renderer-deepening D6/u6.1）。
 *
 * 从 SubagentTab.vue 内联编排下沉而来（行为逐字等价）：组件只保留 readers 面消费
 * （getMessages），写虚拟分区（setMessages / applySubagentStreamDelta /
 * finalizeSubagentStream）属 chat store ops 面——taste-lint 规则
 * no-chat-ops-in-components 禁止组件直取，编排动作归 composable 层。
 *
 * 职责（原组件 loadSubagentData 全量迁移）：
 * - subagent 三段式虚拟 id：fetchAndInject 拉历史 + 恒订阅 stream_delta（E-4 / R3
 *   消解：不依赖 isRunning 陈旧缓存判定订阅时机）+ 客户端 outcome-only 兜底投影（U4 A8）
 * - agentcall 两段式：快照只读，仅拉历史（D4：不接实时流式）+ 登记虚拟 key 到主
 *   session 清理映射（[MUST_FIX 1]，防 deleteSession 泄漏）
 */
import { ref, type ComputedRef } from 'vue'
import { useChatStore } from '@/stores/chat'
import { usePanelStore } from '@/stores/panel'
import {
  useSubagentStore,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
} from '@/stores/subagent'
import {
  useWorkflowStore,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from '@/stores/workflow'
import { getAgentCallHistory } from '@xyz-agent/core/transport/api/domains/session'
import type { Message, SubagentRecord } from '@xyz-agent/shared'
import { DEFAULT_ENGINE_ID } from '@/constants/engine-icons'

interface SubagentTabDataDeps {
  /** 当前选中 subagent 的 record（组件 computed；三段式虚拟 id 才有，agentcall 两段式为 null） */
  currentRecord: ComputedRef<SubagentRecord | null>
  /** 兜底投影的「无结果」文案（i18n key 由组件注入，composable 不绑 useI18n） */
  noOutcomeText: () => string
}

/**
 * subscribeStream 的 drawer scope token（U8 已落地）。
 * subagent store 的 streamUnsub 是单例 Map<scope, unsub>，按此 token keyed（非 panelId）。
 * drawer 单实例同一时刻只订阅一个 subagent：切换 selectedSubagentId 时先 stop 清旧，
 * 再 subscribeStream 起新（同 token 覆盖，store 内部先 stop 再 set）。
 */
const STREAM_SCOPE = 'drawer:subagent'

/** record 实际执行引擎（缺省映射 pi，与 runtime extractRecordEngine 同语义，D5） */
function recordEngine(record: SubagentRecord): string {
  return record.engine || DEFAULT_ENGINE_ID
}

/**
 * 客户端 outcome-only 兜底投影（读链空结果时，U4 A8）：形状对齐 runtime
 * subagent-engine-history 的 ③级 outcomeOnlyMessages（user task + result/error 摘要）。
 */
function outcomeFallbackMessages(record: SubagentRecord, noOutcomeText: string): Message[] {
  const base = record.startedAt ?? Date.now()
  const isErrorOutcome = record.result === undefined && record.error !== undefined
  const messages: Message[] = []
  if (record.task.length > 0) {
    messages.push({ id: `outcome-u-${record.subagentId}`, role: 'user', content: record.task, status: 'complete', timestamp: base })
  }
  messages.push({
    id: `outcome-a-${record.subagentId}`,
    role: 'assistant',
    content: record.result ?? record.error ?? noOutcomeText,
    status: isErrorOutcome ? 'error' : 'complete',
    timestamp: record.endedAt ?? base,
  })
  return messages
}

export function useSubagentTabData(deps: SubagentTabDataDeps) {
  const chatStore = useChatStore()
  const panelStore = usePanelStore()
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  const loadError = ref<string | null>(null)

  /**
   * 按虚拟 id 类型加载对话流数据并注入 chatStore 虚拟分区。
   * - subagent 三段式：fetchAndInject 拉历史 + 恒订阅 stream_delta（E-4 / R3 消解：不再依赖
   *   isRunning 陈旧缓存判定订阅时机——entry 帧消费走 routeInbound 兜底链不依赖 drawer，
   *   stream_delta 订阅打开即挂，非 running 时空转零成本）
   * - agentcall 两段式：快照只读，仅拉历史（D4：不接实时流式）
   */
  async function loadSubagentData(vid: string): Promise<void> {
    loadError.value = null
    try {
      if (isSubagentVirtualId(vid)) {
        const mainSessionId = extractMainSessionId(vid)
        const subId = extractSubagentId(vid)
        await subagentStore.fetchAndInject(mainSessionId, subId, (id, msgs) => chatStore.setMessages(id, msgs))
        // U4 A8 兜底：非 pi record 读链异常返回空（③级保底失效等异常形态）→ 客户端
        // outcome 投影顶上，详情页不白屏。pi 空结果行为不变（正常空 session 也可能是空）。
        const record = deps.currentRecord.value
        if (
          record &&
          recordEngine(record) !== DEFAULT_ENGINE_ID &&
          chatStore.getMessages(vid).length === 0 &&
          (record.result !== undefined || record.error !== undefined)
        ) {
          chatStore.setMessages(vid, outcomeFallbackMessages(record, deps.noOutcomeText()))
        }
        // 恒订阅（U8 scope token；E-4 R3 消解点：订阅时机与 record 状态机解耦）
        subagentStore.subscribeStream(
          STREAM_SCOPE,
          mainSessionId,
          subId,
          vid,
          (id, lines) => chatStore.applySubagentStreamDelta(id, lines),
          (id) => chatStore.finalizeSubagentStream(id),
        )
      } else if (isAgentCallVirtualId(vid)) {
        // D4：agentcall 快照只读。mainSid 从 panelStore 取（虚拟 id 两段式不含 mainSid）。
        const mainSessionId = panelStore.focusedSessionId
        const acsId = extractAgentCallSessionId(vid)
        if (!mainSessionId) return
        const history = await getAgentCallHistory(mainSessionId, acsId)
        chatStore.setMessages(vid, history)
        // [MUST_FIX 1] 登记 agentcall 虚拟 key 到主 session 清理映射：agentcall 两段式无 mainSid
        // 前缀，LRU isVirtualKeyOf 覆盖不到，deleteSession 须经此映射清 agentcall 虚拟分区（防泄漏）。
        // 原 overlay 时代由 workflow.selectAgentCall 内部登记；overlay 移除后 SubagentTab 显式接管。
        workflowStore.registerAgentCall(mainSessionId, vid)
      }
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** 停止当前 drawer scope 的 stream 订阅（切换 subagent / 组件卸载时调） */
  function stopSubagentStream(): void {
    subagentStore.stopStream(STREAM_SCOPE)
  }

  return { loadError, loadSubagentData, stopSubagentStream, recordEngine }
}
