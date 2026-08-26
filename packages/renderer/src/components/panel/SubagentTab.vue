<!--
  SubagentTab —— drawer subagent tab：只读嵌套 subagent 对话流。

  D3 完整复用原则（硬约束）：直接挂主对话流同一个 MessageStream（:session-id=虚拟 id），
  连同其内部 Turn/Block/thinking/tool/markdown 整套渲染树完整复用，不重写任何对话流渲染。
  差异化层仅：标题栏（元信息 + 返回按钮）+ 底部只读提示条（无 composer）+ 空态/错误态。

  两类虚拟 id（D4）：
  - subagent:<mainSid>:<subId> 三段式（chat 块 / sidebar 入口）：
    fetchAndInject 拉历史注入虚拟分区 + running 态 subscribeStream 订阅实时增量
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
        <span v-if="subagentMeta?.meta" class="ml-auto shrink-0 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim">
          {{ subagentMeta.meta }}
        </span>
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
import { AlertCircle, Bot, ChevronLeft, Lock } from '@lucide/vue'
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
import { getAgentCallHistory } from '@/api/domains/session'
import type { WorkflowAgentCall } from '@xyz-agent/shared'
import MessageStream from './MessageStream.vue'

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
const subagentMeta = computed<{ agent: string; slug?: string; meta?: string } | null>(() => {
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

/**
 * 按虚拟 id 类型加载对话流数据并注入 chatStore 虚拟分区。
 * - subagent 三段式：fetchAndInject 拉历史 + running 态 subscribeStream 实时增量
 * - agentcall 两段式：快照只读，仅拉历史（D4：不接实时流式）
 */
async function loadSubagentData(vid: string): Promise<void> {
  loadError.value = null
  try {
    if (isSubagentVirtualId(vid)) {
      const mainSessionId = extractMainSessionId(vid)
      const subId = extractSubagentId(vid)
      await subagentStore.fetchAndInject(mainSessionId, subId, (id, msgs) => chatStore.setMessages(id, msgs))
      // running 态订阅实时增量（U8：scope 用固定 drawer token STREAM_SCOPE）
      if (subagentStore.isRunning(mainSessionId, subId)) {
        subagentStore.subscribeStream(
          STREAM_SCOPE,
          mainSessionId,
          subId,
          vid,
          (id, lines) => chatStore.applySubagentStreamDelta(id, lines),
          (id) => chatStore.finalizeSubagentStream(id),
          (id, msgs) => chatStore.setMessages(id, msgs),
        )
      }
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
