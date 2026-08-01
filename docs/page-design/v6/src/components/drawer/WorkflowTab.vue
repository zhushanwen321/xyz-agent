<script setup lang="ts">
/**
 * WorkflowTab · agent call 列表（phase 分组）
 * wf-header（build-and-deploy · slug + pause/abort 按钮）
 * + phase 分组（4 phase）+ agent call 行（status 圆点 + agent 名 + slug + tokens/turns/耗时）
 * status：running=accent 脉冲 / done=success / failed=danger / pending=dim
 */
import { onBeforeUnmount, ref } from 'vue'
import { drawerTab, subagentSessionId, workflowName } from '@/composables/useStore'

type CallStatus = 'running' | 'done' | 'failed' | 'pending'
type PhaseStatus = 'done' | 'running' | 'pending'

interface AgentCall {
  agent: string
  slug: string
  status: CallStatus
  tokensIn?: string
  tokensOut?: string
  turns?: number
  duration?: string
  /** spec §11：call 对应 subagent session，点击切 subagent tab 时传入 */
  sessionId?: string
}

interface Phase {
  name: string
  status: PhaseStatus
  calls: AgentCall[]
}

const phases: Phase[] = [
  {
    name: 'build',
    status: 'done',
    calls: [
      { agent: 'installer', slug: 'install-deps', status: 'done', tokensIn: '1.2k', tokensOut: '800', turns: 4, duration: '8s' },
      { agent: 'builder', slug: 'compile-bundle', status: 'done', tokensIn: '3.4k', tokensOut: '1.1k', turns: 6, duration: '42s' },
    ],
  },
  {
    name: 'test',
    status: 'running',
    calls: [
      { agent: 'tester', slug: 'run-unit-tests', status: 'running', tokensIn: '880', tokensOut: '420', turns: 3, sessionId: 'sess_t1u2' },
      { agent: 'tester', slug: 'run-e2e', status: 'pending' },
    ],
  },
  {
    name: 'review',
    status: 'pending',
    calls: [{ agent: 'reviewer', slug: 'audit-changes', status: 'pending' }],
  },
  {
    name: 'deploy',
    status: 'pending',
    calls: [
      { agent: 'deployer', slug: 'publish-npm', status: 'pending' },
      { agent: 'deployer', slug: 'release-notes', status: 'failed', tokensIn: '800', tokensOut: '400', turns: 2, duration: '5s' },
    ],
  },
]

/** abort 两段式确认（spec §11：3s 内无第二次点击自动复位） */
const abortConfirming = ref(false)
let abortTimer: ReturnType<typeof setTimeout> | null = null
function onAbortClick() {
  if (!abortConfirming.value) {
    abortConfirming.value = true
    abortTimer = setTimeout(() => {
      abortConfirming.value = false
      abortTimer = null
    }, 3000)
    return
  }
  /* demo：执行终止 */
  abortConfirming.value = false
  if (abortTimer) {
    clearTimeout(abortTimer)
    abortTimer = null
  }
}
onBeforeUnmount(() => {
  if (abortTimer) clearTimeout(abortTimer)
})

/** 选中 agent call（demo 高亮） */
const selectedSlug = ref<string | null>(null)

/** 点击 agent call → 高亮 + 切 subagent tab + 传 sessionId（spec §11） */
function onCallClick(call: AgentCall) {
  selectedSlug.value = call.slug
  subagentSessionId.value = call.sessionId ?? null
  drawerTab.value = 'subagent'
}
</script>

<template>
  <div class="wf-v6">
    <!-- 标题栏：surface + hairline（方案 G） + 右侧操作 -->
    <div class="wf-header">
      <svg class="wf-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" />
      </svg>
      <span class="wf-name">{{ workflowName ?? 'build-and-deploy' }}</span>
      <span class="wf-slug">· release-v6</span>
      <div class="wf-acts">
        <!-- pause（运行态显 pause）-->
        <button class="wf-act" title="暂停 workflow（两段式确认）">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" />
          </svg>
        </button>
        <!-- abort（两段式确认）-->
        <button
          class="wf-act danger"
          :class="{ confirm: abortConfirming }"
          :title="abortConfirming ? '再次点击确认终止' : '终止 workflow（两段式确认）'"
          @click="onAbortClick"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 空态：未选中 workflow（spec §11）入口 = 消息流 workflow block 点击 -->
    <div v-if="!workflowName" class="wf-empty">
      <svg class="wf-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" />
      </svg>
      <span class="wf-empty-text">未选中 workflow</span>
      <span class="wf-empty-sub">点击对话流的 workflow block 查看 agent call 列表</span>
    </div>

    <!-- 内容区：phase 分组 + agent call 列表 -->
    <div v-else class="wf-body">
      <div v-for="(phase, pi) in phases" :key="pi" class="wf-phase">
        <div class="wf-phase-head">
          <span class="wf-phase-dot" :class="phase.status"></span>
          <span class="wf-phase-name">{{ phase.name }}</span>
          <span class="wf-phase-count">{{ phase.calls.length }} {{ phase.calls.length === 1 ? 'agent' : 'agents' }}</span>
        </div>

        <div
          v-for="(call, ci) in phase.calls"
          :key="ci"
          class="wf-call"
          :class="{ selected: selectedSlug === call.slug }"
          :title="call.sessionId ? '点击切到 subagent tab 展示该 agent 对话流' : ''"
          @click="onCallClick(call)"
        >
          <span class="wf-status" :class="call.status"></span>
          <span class="wf-agent">{{ call.agent }}</span>
          <span class="wf-call-slug">{{ call.slug }}</span>
          <div class="wf-summary">
            <template v-if="call.status === 'running'">
              <span class="wf-tokens">↑{{ call.tokensIn }} ↓{{ call.tokensOut }}</span>
              <span>{{ call.turns }} turns</span>
              <span class="wf-running">running…</span>
            </template>
            <template v-else-if="call.status === 'pending'">
              <span class="wf-pending">pending</span>
            </template>
            <template v-else>
              <span class="wf-tokens">↑{{ call.tokensIn }} ↓{{ call.tokensOut }}</span>
              <span>{{ call.turns }} turns</span>
              <span>{{ call.duration }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-v6 {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-height: 0;
  overflow: hidden;
}

/* 标题栏：surface + hairline（方案 G） */
.wf-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
  flex-shrink: 0;
}
.wf-header .wf-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.wf-header .wf-name {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  font-weight: 500;
}
.wf-header .wf-slug {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.wf-acts {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.wf-act {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--ease);
}
.wf-act:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.wf-act.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.wf-act.confirm {
  background: var(--danger-soft);
  color: var(--danger);
}
.wf-act.confirm:hover {
  background: color-mix(in oklch, var(--danger) 22%, transparent);
}
.wf-act:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}

/* 内容区 */
.wf-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* phase 分组 */
.wf-phase {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wf-phase-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
}
.wf-phase-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.wf-phase-dot.done {
  background: var(--success);
}
.wf-phase-dot.running {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  animation: wf-pulse 1.8s ease-in-out infinite;
}
.wf-phase-dot.pending {
  background: var(--neutral-dim);
  opacity: 0.5;
}
@keyframes wf-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.wf-phase-name {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  font-weight: 500;
}
.wf-phase-count {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}

/* agent call 行 */
.wf-call {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.wf-call:hover {
  background: var(--surface-hover);
}
.wf-call.selected {
  background: var(--surface);
}
.wf-call.selected:hover {
  background: var(--surface);
}

.wf-call .wf-status {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.wf-call .wf-status.done {
  background: var(--success);
}
.wf-call .wf-status.failed {
  background: var(--danger);
}
.wf-call .wf-status.pending {
  background: var(--neutral-faint);
}
.wf-call .wf-status.running {
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent-soft);
  border-top-color: var(--accent);
  border-radius: 50%;
  background: transparent;
  animation: wf-spin 0.8s linear infinite;
}
@keyframes wf-spin {
  to {
    transform: rotate(360deg);
  }
}

.wf-call .wf-agent {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  font-weight: 500;
  flex-shrink: 0;
}
.wf-call.selected .wf-agent {
  color: var(--accent);
}
.wf-call .wf-call-slug {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.wf-call .wf-summary {
  margin-left: auto;
  display: flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.wf-call .wf-summary .wf-tokens {
  color: var(--neutral-mid);
}
.wf-call .wf-summary .wf-running {
  color: var(--accent);
}
.wf-call .wf-summary .wf-pending {
  color: var(--neutral-faint);
}

/* 空态（spec §11）*/
.wf-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--neutral-dim);
  padding: 24px;
  text-align: center;
}
.wf-empty .wf-empty-ico {
  width: 28px;
  height: 28px;
  opacity: 0.4;
}
.wf-empty .wf-empty-text {
  font-size: var(--text-sm);
}
.wf-empty .wf-empty-sub {
  font-size: var(--text-xs);
  opacity: 0.6;
}
</style>
