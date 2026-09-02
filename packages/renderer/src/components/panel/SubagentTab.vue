<!--
  SubagentTab —— drawer subagent tab：只读嵌套 subagent 对话流。

  D3 完整复用原则（硬约束）：直接挂主对话流同一个 MessageStream（:session-id=虚拟 id），
  连同其内部 Turn/Block/thinking/tool/markdown 整套渲染树完整复用，不重写任何对话流渲染。
  差异化层仅：标题栏（元信息 + 返回按钮）+ 底部只读提示条（无 composer）+ 空态/错误态。

  两类虚拟 id（D4）：
  - subagent:<mainSid>:<subId> 三段式（chat 块 / sidebar 入口）：
    fetchAndInject 拉历史注入虚拟分区 + 恒订阅 stream_delta 实时增量（E-4：entry 帧走
    routeInbound 兜底链消费，不依赖 drawer 打开；此处只管打字机 delta）
  - agentcall:<acsId> 两段式（workflow tab 点 agent call 入口）：
    快照只读，仅拉历史不接实时流式（D4 裁决：agent call 实时性由 workflow tab 列表 status 体现）

  mainSid 来源：panelStore.focusedSessionId（主 session）。
  MessageStream 对虚拟 id 透明（chatStore.messages Map 按虚拟 id 分区），forceWorking
  内部已按 isSubagentVirtualId 判定（agentcall 不生效，快照视图）。
-->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="drawer-subagent-tab">
    <!-- 空态：未选中 subagent（selectedSubagentId === null） -->
    <div
      v-if="!selectedSubagentId"
      class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="drawer-subagent-empty"
    >
      <Bot class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-70">{{ t('panel.sideDrawer.noSubagent') }}</p>
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-50">{{ t('panel.sideDrawer.subagentHint') }}</p>
    </div>

    <template v-else>
      <!-- 标题栏：差异化层（enteredFrom==='workflow' 显返回按钮；agent·slug + model·thinking 元信息） -->
      <div class="flex shrink-0 items-center gap-2 bg-surface-2 px-2.5 py-1.5">
        <Button
          v-if="enteredFrom === 'workflow'"
          variant="ghost"
          size="icon"
          class="size-6 shrink-0 text-neutral-dim hover:text-neutral-fg"
          :title="t('panel.sideDrawer.backToWorkflow')"
          data-testid="drawer-subagent-back"
          @click="onBack"
        >
          <ChevronLeft class="size-3.5" />
        </Button>
        <Bot class="size-3.5 shrink-0 text-neutral-dim" />
        <span class="min-w-0 truncate font-mono text-xs font-medium text-neutral-fg">
          {{ subagentMeta?.agent ?? 'subagent' }}
        </span>
        <span v-if="subagentMeta?.slug" class="min-w-0 shrink-0 truncate font-mono text-xs text-neutral-dim">
          · {{ subagentMeta.slug }}
        </span>
        <!-- 引擎 badge（U3 D9）：常态引擎名；engineFallback 存在 → 警告态 + 回退文案 -->
        <span
          class="shrink-0 rounded-sm px-1 font-mono text-[length:var(--text-3xs)] leading-4"
          :class="subagentMeta?.engineFallback ? 'bg-warn-soft text-warn' : 'border border-hairline text-neutral-dim'"
          :title="engineBadgeTitle"
          data-testid="subagent-engine-badge"
        >{{ engineBadgeText }}</span>
        <span v-if="subagentMeta?.meta" class="ml-auto shrink-0 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim">
          {{ subagentMeta.meta }}
        </span>
      </div>

      <!-- 运行中 coarse 提示（U4 D7）：非 pi 引擎 running 任务不支持实时流，如实提示不伪造流。
           pi 任务恒不出现（D5：undefined 缺省映射为 pi）。 -->
      <div
        v-if="coarseHintVisible"
        class="flex shrink-0 items-center gap-1.5 border-b border-hairline bg-surface-2 px-3 py-1.5 text-[10px] text-neutral-dim"
        data-testid="subagent-coarse-hint"
      >
        <Clock class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.sideDrawer.subagentCoarseHint', { engine: coarseHintEngine }) }}</span>
      </div>

      <!-- 错误态：历史加载失败（fail-fast，提供重试入口，不阻塞主对话流） -->
      <div
        v-if="loadError"
        class="flex flex-col items-center justify-center gap-2 p-6 text-center"
        data-testid="drawer-subagent-error"
      >
        <AlertCircle class="size-5 text-danger opacity-60" />
        <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.sideDrawer.subagentLoadFailed') }}</p>
        <p class="max-w-full break-all text-[length:var(--text-3xs)] text-neutral-dim opacity-60">{{ loadError }}</p>
        <!-- 非 pi record 加载失败时的 outcome 摘要兜底（A8：详情页永不白屏） -->
        <p
          v-if="outcomeSummaryText"
          class="max-w-full break-words text-[length:var(--text-2xs)] text-neutral-mid"
          data-testid="subagent-outcome-summary"
        >{{ outcomeSummaryText }}</p>
        <Button variant="ghost" class="h-6 text-[length:var(--text-2xs)] text-accent" data-testid="drawer-subagent-retry" @click="reload">
          {{ t('panel.sideDrawer.subagentRetry') }}
        </Button>
      </div>

      <!-- 对话流：复用 MessageStream（D3 硬约束，禁止重建任何 turn/block/thinking/markdown 渲染）。
           MessageStream 按 :session-id 读 chatStore.messages 虚拟分区，对虚拟 id 完全透明。 -->
      <MessageStream v-else :session-id="selectedSubagentId" />

      <!-- 底部只读提示条（差异化层：subagent 为 background 任务，无 composer） -->
      <div class="flex shrink-0 items-center gap-1.5 border-t border-hairline px-3 py-1.5 text-[length:var(--text-3xs)] text-neutral-dim">
        <Lock class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.sideDrawer.subagentReadonly') }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Bot, ChevronLeft, Clock, Lock } from '@lucide/vue'
import { Button } from '@xyz-agent/ui'
import { useDrawerControl, openWorkflow } from '@xyz-agent/core/domain/drawer'
import { usePanelStore } from '@/stores/panel'
import { useChatStore } from '@/stores/chat'
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
import type { Message, SubagentRecord, WorkflowAgentCall } from '@xyz-agent/shared'
import MessageStream from './MessageStream.vue'
import { DEFAULT_ENGINE_ID } from '@/constants/engine-icons'

const { t } = useI18n()
const panelStore = usePanelStore()
const chatStore = useChatStore()
const subagentStore = useSubagentStore()
const workflowStore = useWorkflowStore()

const { selectedSubagentId, enteredFrom } = useDrawerControl()

/**
 * subscribeStream 的 drawer scope token（U8 已落地）。
 * subagent store 的 streamUnsub 是单例 Map<scope, unsub>，按此 token keyed（非 panelId）。
 * drawer 单实例同一时刻只订阅一个 subagent：切换 selectedSubagentId 时先 stopStream 清旧，
 * 再 subscribeStream 起新（同 token 覆盖，store 内部先 stop 再 set）。
 */
const STREAM_SCOPE = 'drawer:subagent'

const loadError = ref<string | null>(null)

/** 从 workflowStore records 查找指定 acsId 的 agent call（agentcall 入口的元信息来源） */
function findAgentCall(acsId: string): WorkflowAgentCall | undefined {
  const mainSessionId = panelStore.focusedSessionId
  if (!mainSessionId) return undefined
  for (const wf of workflowStore.getRecordsBySession(mainSessionId)) {
    const call = wf.agentCalls.find((c) => c.sessionId === acsId)
    if (call) return call
  }
  return undefined
}

/** 标题栏元信息（响应式：records 变化时重算） */
const subagentMeta = computed<{ agent: string; slug?: string; meta?: string; engine?: string; engineFallback?: { from: string; reason: string } } | null>(() => {
  const vid = selectedSubagentId.value
  if (!vid) return null

  if (isSubagentVirtualId(vid)) {
    const mainSessionId = extractMainSessionId(vid)
    const subId = extractSubagentId(vid)
    const record = subagentStore.getRecordsBySession(mainSessionId).find((r) => r.subagentId === subId)
    if (!record) return null
    const metaParts: string[] = []
    if (record.model) metaParts.push(record.model)
    if (record.thinkingLevel) metaParts.push(`thinking ${record.thinkingLevel}`)
    return {
      agent: record.agent,
      slug: record.slug || undefined,
      meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
      engine: record.engine || undefined,
      engineFallback: record.engineFallback,
    }
  }

  if (isAgentCallVirtualId(vid)) {
    const call = findAgentCall(extractAgentCallSessionId(vid))
    if (!call) return null
    return {
      agent: call.agent,
      // model 'default' 不显示（对齐 WorkflowDetail modelDefault 语义）
      meta: call.model && call.model !== 'default' ? call.model : undefined,
    }
  }

  return null
})

/** 引擎 badge 文案（U3 D9）：常态引擎名（缺省 pi）；fallback 警告态显示回退链 */
const engineBadgeText = computed<string>(() => {
  const meta = subagentMeta.value
  const engine = meta?.engine || DEFAULT_ENGINE_ID
  if (meta?.engineFallback) {
    return t('panel.sideDrawer.engineFallbackBadge', { from: meta.engineFallback.from, to: engine })
  }
  return engine
})

/** 引擎 badge title：常态 = 引擎名；fallback = 恢复指引 */
const engineBadgeTitle = computed<string>(() => {
  const meta = subagentMeta.value
  if (meta?.engineFallback) {
    return t('panel.sideDrawer.engineFallbackHint', { from: meta.engineFallback.from, to: meta.engine || DEFAULT_ENGINE_ID })
  }
  return t('panel.sideDrawer.engineBadgeTitle', { engine: meta?.engine || DEFAULT_ENGINE_ID })
})

/** 当前选中 subagent 的 record（三段式虚拟 id 才有；agentcall 两段式返回 null） */
const currentRecord = computed<SubagentRecord | null>(() => {
  const vid = selectedSubagentId.value
  if (!vid || !isSubagentVirtualId(vid)) return null
  const record = subagentStore
    .getRecordsBySession(extractMainSessionId(vid))
    .find((r) => r.subagentId === extractSubagentId(vid))
  return record ?? null
})

/** record 实际执行引擎（缺省映射 pi，与 runtime extractRecordEngine 同语义，D5） */
function recordEngine(record: SubagentRecord): string {
  return record.engine || DEFAULT_ENGINE_ID
}

/**
 * 运行中 coarse 提示可见性（U4 D7）：非 pi 引擎 + 任务真在跑（窄口径同
 * isStreamingSubagent：running 且无轮终 result、非 resumable）。pi 恒 false（D5）。
 */
const coarseHintVisible = computed<boolean>(() => {
  const record = currentRecord.value
  if (!record || recordEngine(record) === DEFAULT_ENGINE_ID) return false
  return subagentStore.isStreamingSubagent(extractMainSessionId(selectedSubagentId.value ?? ''), record.subagentId)
})

/** coarse 提示的引擎名（可见时 record.engine 恒非空非 pi） */
const coarseHintEngine = computed<string>(() => {
  const record = currentRecord.value
  return record ? recordEngine(record) : DEFAULT_ENGINE_ID
})

/**
 * 加载失败时的 outcome 摘要文案（A8 不白屏）：非 pi record 且有 result/error 时
 * 在错误态面板中展示，详情页至少有任务结果可读。
 */
const outcomeSummaryText = computed<string | null>(() => {
  const record = currentRecord.value
  if (!record || recordEngine(record) === DEFAULT_ENGINE_ID) return null
  const outcome = record.result ?? record.error
  return outcome !== undefined ? outcome : null
})

/**
 * 客户端 outcome-only 兜底投影（读链空结果时，U4 A8）：形状对齐 runtime
 * subagent-engine-history 的 ③级 outcomeOnlyMessages（user task + result/error 摘要）。
 */
function outcomeFallbackMessages(record: SubagentRecord): Message[] {
  const base = record.startedAt ?? Date.now()
  const isErrorOutcome = record.result === undefined && record.error !== undefined
  const messages: Message[] = []
  if (record.task.length > 0) {
    messages.push({ id: `outcome-u-${record.subagentId}`, role: 'user', content: record.task, status: 'complete', timestamp: base })
  }
  messages.push({
    id: `outcome-a-${record.subagentId}`,
    role: 'assistant',
    content: record.result ?? record.error ?? t('panel.sideDrawer.subagentNoOutcome'),
    status: isErrorOutcome ? 'error' : 'complete',
    timestamp: record.endedAt ?? base,
  })
  return messages
}

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
      const record = currentRecord.value
      if (
        record &&
        recordEngine(record) !== DEFAULT_ENGINE_ID &&
        chatStore.getMessages(vid).length === 0 &&
        (record.result !== undefined || record.error !== undefined)
      ) {
        chatStore.setMessages(vid, outcomeFallbackMessages(record))
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

/** selectedSubagentId 变化：停旧订阅 + 加载新数据（immediate 覆盖 onMounted 首次加载） */
watch(
  selectedSubagentId,
  (vid, oldVid) => {
    if (oldVid) subagentStore.stopStream(STREAM_SCOPE)
    if (vid) void loadSubagentData(vid)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  subagentStore.stopStream(STREAM_SCOPE)
})

function reload(): void {
  const vid = selectedSubagentId.value
  if (vid) void loadSubagentData(vid)
}

function onBack(): void {
  openWorkflow()
}
</script>
