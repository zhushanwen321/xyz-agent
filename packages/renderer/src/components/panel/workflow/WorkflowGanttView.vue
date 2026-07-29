<template>
  <!--
    展示组件 · workflow 时间轴 Gantt 视图（视图 D，W3 wave）。
    与 WorkflowDagView 相同 props/emit 契约，后续容器组件 toggle 切换。
    横条长度 = 执行时长，重叠 = 并发，running 节点每秒重算右端（NOW 随推进）。
    点击非 pending 横条 → emit('select-agent-call', { agentCallSessionId })。
  -->
  <div class="flex flex-col gap-2 px-1 py-1" data-testid="workflow-gantt-view">
    <!-- 有时间数据：渲染时间轴 + 行 + NOW 线 -->
    <div v-if="hasTimed" class="relative flex flex-col gap-1">
      <!-- 时间轴标签行：开始 / 结束（占位对齐左侧 label 列宽） -->
      <div class="flex items-center font-mono text-[10px] text-neutral-dim" :style="{ gap: `${GAP_REM}rem` }" data-testid="workflow-gantt-axis">
        <span class="shrink-0" :style="{ width: `${LABEL_COL_PX}px` }" />
        <span class="flex flex-1 justify-between">
          <span>{{ t('panel.sideDrawer.workflowDag.ganttAxisStart') }}</span>
          <span>{{ t('panel.sideDrawer.workflowDag.ganttAxisEnd') }}</span>
        </span>
      </div>

      <!-- 每个有时间节点一行：左侧 label（agent + 状态点）+ 右侧 track（横条） -->
      <div
        v-for="node in flatNodes"
        :key="node.id"
        class="flex items-center"
        :style="{ gap: `${GAP_REM}rem` }"
      >
        <!-- 左侧 label 列：固定宽度（LABEL_COL_PX），状态点 + agent 名 -->
        <div
          class="flex shrink-0 items-center gap-1.5 overflow-hidden"
          :style="{ width: `${LABEL_COL_PX}px` }"
          :title="node.agent"
        >
          <span class="size-1.5 shrink-0 rounded-full" :class="callDotClass(node.status)" />
          <span class="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight text-neutral-fg">
            {{ node.agent }}
          </span>
          <span class="shrink-0 font-mono text-[10px] text-neutral-dim">#{{ node.id }}</span>
        </div>

        <!-- 右侧 track：横条按 left/width 百分比定位 -->
        <div
          class="relative h-[18px] flex-1 overflow-hidden rounded-sm bg-bg-input"
          data-testid="workflow-gantt-track"
        >
          <div
            class="absolute top-0 flex h-full items-center overflow-hidden whitespace-nowrap rounded-sm px-1.5 text-[10px] font-medium text-white transition-colors"
            :class="[barClass(node), isClickable(node) ? 'cursor-pointer' : 'cursor-default']"
            :style="{ left: barGeometry(node).left, width: barGeometry(node).width }"
            data-testid="workflow-gantt-bar"
            :title="node.agent"
            role="button"
            :aria-disabled="!isClickable(node)"
            :tabindex="isClickable(node) ? 0 : undefined"
            @click="onNodeClick(node)"
          >
            {{ barLabel(node) }}
          </div>
        </div>
      </div>

      <!-- NOW 线：有 running 节点时竖线 = 当前时刻（left = label 列宽 + gap + track 内百分比，对齐 track 左端起算） -->
      <span
        v-if="nowLeftPct !== null"
        class="pointer-events-none absolute bottom-0 top-[18px] w-px bg-accent"
        :style="{ left: `calc(${LABEL_COL_PX}px + ${GAP_REM}rem + ${nowLeftPct}%)` }"
        aria-hidden="true"
        data-testid="workflow-gantt-now-line"
      />

      <!-- hint 行：说明横条语义 -->
      <div class="mt-1 px-1 text-[10px] text-neutral-dim">
        {{ t('panel.sideDrawer.workflowDag.ganttHint') }}
      </div>
    </div>

    <!-- pending 区：待执行节点（与 DAG 视图一致的虚线边框） -->
    <div v-if="pendingNodes.length" data-testid="workflow-gantt-pending">
      <div class="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-dim">
        {{ t('panel.sideDrawer.workflowDag.pendingTitle') }}
      </div>
      <div class="flex flex-col gap-2">
        <div
          v-for="node in pendingNodes"
          :key="node.id"
          class="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-2.5 py-1.5 opacity-50"
          data-testid="workflow-gantt-pending-node"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-neutral-dim" />
          <span class="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight text-neutral-fg">
            {{ node.agent }}
          </span>
          <span class="shrink-0 font-mono text-[10px] text-neutral-dim">#{{ node.id }}</span>
        </div>
      </div>
    </div>

    <!-- 无时间数据：有 pending 但无 timed 节点时显提示（区别于完全空态） -->
    <div
      v-if="!hasTimed && pendingNodes.length"
      class="py-4 text-center text-[11px] text-neutral-dim"
      data-testid="workflow-gantt-no-time"
    >
      {{ t('panel.sideDrawer.workflowDag.ganttNoTimeData') }}
    </div>

    <!-- 完全空态：无 layers 且无 pending -->
    <div
      v-if="flatNodes.length === 0 && pendingNodes.length === 0"
      class="py-8 text-center text-[11px] text-neutral-dim"
      data-testid="workflow-gantt-empty"
    >
      {{ t('panel.sideDrawer.workflowDag.empty') }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * WorkflowGanttView —— 时间轴 Gantt 视图（视图 D，W3 wave）。
 *
 * 纯展示组件：消费 ExecutionLayer[] + pendingNodes，拍平所有节点后按执行时间区间
 * 渲染横条。与 WorkflowDagView 相同 props/emit 契约（可互换）。
 *
 * 复用：parseT（统一时间解析口径）+ callDotClass/formatDuration（共享配色与耗时格式）。
 * 不复用 compute-layers 内部的 computeEnd（按契约组件内自行实现同口径逻辑）。
 *
 * running 节点：end = Date.now() 随时间推进，setInterval 每秒 tick 触发横条重算。
 * 生命周期严格复用 useTurnElapsed.ts 的 start/stop + onUnmounted 范式（RK1 高风险）。
 */
import type { ExecutionLayer } from '@/composables/workflow/compute-layers'
import type { WorkflowAgentCall } from '@xyz-agent/shared'
import { callDotClass, formatDuration } from '@/composables/workflow/format'
import { parseT } from '@/composables/workflow/compute-layers'
import { useI18n } from 'vue-i18n'
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  layers: ExecutionLayer[]
  pendingNodes: WorkflowAgentCall[]
}>()

/** select-agent-call 事件载荷契约：单个 payload 对象（规则 #1，与 WorkflowDagView 一致）。 */
interface SelectAgentCallPayload {
  agentCallSessionId: string
}

const emit = defineEmits<{
  'select-agent-call': [payload: SelectAgentCallPayload]
}>()

const { t } = useI18n()

// ── 常量（抽常量避免 no-magic-numbers，与 stores/tasks.ts、panel/GoalCard.vue 范式一致）──
const PERCENT_MULTIPLIER = 100 // 分数 → 百分比换算系数
const PERCENT_MAX = 100 // 百分比上界（NOW 线越界判断 / span===0 时横条占满）
const MIN_BAR_WIDTH_PCT = 2 // 横条最小宽度百分比（极短任务仍可见，防被 span 压成 0）
const GANTT_TICK_MS = 1000 // running 横条重算 tick 间隔（每秒推进 NOW）
const LABEL_COL_PX = 112 // 左侧 label 列固定宽度（px，与 axis 占位 / label 列 / NOW 线偏移三处共享）
const GAP_REM = 0.5 // label 列与 track 之间的横向间距（rem，对应 tailwind gap-2 = 0.5rem）

/** 把所有 layer 节点拍平，得到全部有时间节点。 */
const flatNodes = computed<WorkflowAgentCall[]>(() =>
  props.layers.flatMap((l) => l.nodes),
)

/** nowTick：每秒自增触发 running 横条重算（建立 computed 依赖）。 */
const nowTick = ref(0)

/** running 节点存在 → 需 tick；无 running 静态不跑 timer。 */
const hasRunning = computed(() => flatNodes.value.some((n) => n.status === 'running'))

/** 有时间数据的节点（startedAt 非空）。 */
const hasTimed = computed(() => flatNodes.value.some((n) => Boolean(n.startedAt)))

/**
 * 计算节点执行区间右端 end（毫秒，按优先级）：
 * - running → Date.now()（随推进）
 * - 有 durationMs → start + durationMs
 * - failed 且有 completedAt → parseT(completedAt)
 * - 否则 → start
 */
function computeEnd(node: WorkflowAgentCall): number {
  const start = parseT(node.startedAt)
  if (node.status === 'running') return Date.now()
  if (typeof node.durationMs === 'number') return start + node.durationMs
  if (node.status === 'failed' && node.completedAt) return parseT(node.completedAt)
  return start
}

/** 全局时间范围：minT = 最早 start，maxT = 最晚 end。防全 -1（非法时间）用 0 兜底。 */
const timeRange = computed<{ minT: number; maxT: number; span: number }>(() => {
  void nowTick.value // 建立依赖：running tick 后 maxT 重算
  const timed = flatNodes.value.filter((n) => parseT(n.startedAt) !== -1)
  if (timed.length === 0) return { minT: 0, maxT: 0, span: 0 }
  let minT = Number.POSITIVE_INFINITY
  let maxT = Number.NEGATIVE_INFINITY
  for (const n of timed) {
    const s = parseT(n.startedAt)
    const e = computeEnd(n)
    if (s < minT) minT = s
    if (e > maxT) maxT = e
  }
  const span = Math.max(1, maxT - minT)
  return { minT, maxT, span }
})

/** 单节点横条几何：leftPct / widthPct（防除零：span===0 width 给 100）。 */
function barGeometry(node: WorkflowAgentCall): { left: string; width: string } {
  void nowTick.value // 建立依赖：running tick 后重算
  const { minT, span } = timeRange.value
  const start = parseT(node.startedAt)
  const end = computeEnd(node)
  const leftPct = span > 0 ? ((start - minT) / span) * PERCENT_MULTIPLIER : 0
  const widthPct = span > 0 ? Math.max(((end - start) / span) * PERCENT_MULTIPLIER, MIN_BAR_WIDTH_PCT) : PERCENT_MAX
  return { left: `${leftPct}%`, width: `${widthPct}%` }
}

/**
 * NOW 线位置：换算成 track 内百分比。
 *
 * 复用 timeRange.maxT（已经是全局最大 end）：running 节点的 computeEnd === Date.now()，
 * 在同一刻度内所有 running 节点 end 相等，故 maxT === Date.now() === 任意 running 节点 end。
 * 无需再遍历 running 节点重新取最大值（与 barGeometry 共享 timeRange，避免几何口径重复）。
 */
const nowLeftPct = computed<number | null>(() => {
  void nowTick.value
  if (!hasRunning.value) return null
  const { minT, maxT, span } = timeRange.value
  if (span <= 0) return null
  const pct = ((maxT - minT) / span) * PERCENT_MULTIPLIER
  return pct < 0 || pct > PERCENT_MAX ? null : pct
})

/** 横条配色：completed→success / failed→danger / running→accent / pending→中性。 */
function barClass(node: WorkflowAgentCall): string {
  switch (node.status) {
    case 'completed': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'running': return 'animate-pulse bg-accent'
    // 防御性保留：compute-layers 把无 startedAt 的 pending 节点路由到 pendingNodes，
    // 不会进入 layers/flatNodes 的轨道，故此处 default（pending）分支正常不可达。
    // 保留是为防上游契约变更导致 pending 节点误入轨道时仍有兜底配色（避免裸色横条）。
    default: return 'bg-neutral-faint'
  }
}

/** 横条内文案：有 durationMs 显耗时，running 显「进行中」，否则空。 */
function barLabel(node: WorkflowAgentCall): string {
  if (typeof node.durationMs === 'number') return formatDuration(node.durationMs)
  if (node.status === 'running') return t('panel.sideDrawer.workflowDag.ganttRunning')
  return ''
}

/** pending 不可点（无 sessionId）；非 pending 且有 sessionId 才可点。 */
function isClickable(node: WorkflowAgentCall): boolean {
  return node.status !== 'pending' && Boolean(node.sessionId)
}

function onNodeClick(node: WorkflowAgentCall): void {
  if (isClickable(node)) emit('select-agent-call', { agentCallSessionId: node.sessionId! })
}

// ── setInterval 生命周期（严格复用 useTurnElapsed.ts 范式，RK1）──
let ganttTimer: ReturnType<typeof setInterval> | null = null

function stopTimer(): void {
  if (ganttTimer) {
    clearInterval(ganttTimer)
    ganttTimer = null
  }
}

function startTimer(): void {
  stopTimer()
  ganttTimer = setInterval(() => {
    nowTick.value++
  }, GANTT_TICK_MS)
}

watch(hasRunning, (running) => {
  if (running) startTimer()
  else stopTimer()
}, { immediate: true })

onUnmounted(stopTimer)
</script>
