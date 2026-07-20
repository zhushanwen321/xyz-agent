<!--
  GoalCard —— TasksPanel 的 goal 卡片子组件。

  不直接渲染 goal_control tool 的 card GuiComponent（现有 Card.vue 不支持 warning variant、
  resume 按钮、objective 两行截断）。本组件从 GoalSnapshot 自定义渲染：
  · slug 标题（来自 store 的 goal.slug，回退 card header）
  · objective 两行截断（来自 store 的 goal.objective，undefined 时不渲染）
  · budget 进度条（遍历 gui.props.body 找 progress-bar，取 label/current/total/severity）
  · status 徽章（优先 goal.liveStatus 实时值，回退 stats-line items 推断）
  · blocked 强引导：warning 渐变背景 + warning 边框 + Resume 按钮 + 视觉置顶（由父组件 order 控制）

  数据提取全部走类型守卫/类型断言（带注释），不信任外部 GuiComponent 形状。
-->
<template>
  <div
    class="goal-card relative overflow-hidden rounded-lg border p-3"
    :class="cardClass"
    data-testid="goal-card"
  >
    <!-- blocked 渐变背景层（warning-soft → surface，余光可捕获）。
         Tailwind 任意值渐变 + CSS 变量，主题切换自动跟随。 -->
    <div
      v-if="isBlocked"
      class="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,var(--warning-soft)_0%,var(--surface)_70%)]"
      aria-hidden="true"
    />

    <div class="relative flex flex-col gap-2">
      <!-- 标题行：slug + status 徽章 -->
      <div class="flex items-center gap-2">
        <span
          v-if="statusIcon"
          class="shrink-0"
          :class="statusIconClass"
        >
          <component :is="statusIcon" class="size-3.5" />
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-fg">
          {{ displaySlug }}
        </span>
        <span
          class="shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          :class="badgeClass"
        >
          {{ statusLabel }}
        </span>
      </div>

      <!-- objective 两行截断（undefined 时不渲染） -->
      <p
        v-if="goal.objective"
        class="line-clamp-2 text-[12px] leading-[1.5] text-muted"
        :title="goal.objective"
      >
        {{ goal.objective }}
      </p>

      <!-- budget 进度条（遍历 gui.props.body 找 progress-bar，有 budget 才有） -->
      <div v-if="progressBars.length > 0" class="flex flex-col gap-1.5">
        <div
          v-for="bar in progressBars"
          :key="bar.label"
          class="flex items-center gap-2"
        >
          <span class="w-10 shrink-0 font-mono text-[10px] text-subtle">{{ bar.label }}</span>
          <div class="h-1 flex-1 overflow-hidden rounded-sm bg-bg-input">
            <div
              class="h-full rounded-sm transition-[width] duration-300"
              :class="bar.fillClass"
              :style="{ width: bar.percent }"
            />
          </div>
          <span class="shrink-0 font-mono text-[10px] tabular-nums text-muted">{{ bar.value }}</span>
        </div>
      </div>

      <!-- 预算耗尽/超时提示（budget_limited / time_limited 时显，替代进度条语义） -->
      <p v-if="exhaustedHint" class="flex items-center gap-1 text-[11px] text-danger">
        <component :is="exhaustedHintIcon" class="size-3" />
        {{ exhaustedHint }}
      </p>

      <!-- Resume 按钮（仅 blocked 时显，点击注入 /goal resume slash chip） -->
      <Button
        v-if="isBlocked"
        variant="default"
        size="sm"
        class="mt-1 h-7 self-start gap-1 border-warning bg-warning text-[11px] text-bg hover:brightness-110"
        data-testid="goal-resume-btn"
        @click="onResume"
      >
        <Play class="size-3" />
        {{ t('panel.panel.tasks.resumeGoal') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, AlertTriangle, CheckCircle, Pause, Ban, Hourglass } from '@lucide/vue'
import type { Component } from 'vue'
import type { GuiComponent, StatItem } from '@xyz-agent/extension-protocol'
import { Button } from '@/components/ui/button'
import { useCommandStore } from '@/stores/command'
import type { GoalLiveStatus, GoalSnapshot } from '@/stores/tasks'

const props = defineProps<{
  goal: GoalSnapshot
  /** 注入 /goal resume 的目标 session */
  sessionId: string | null
}>()

const { t } = useI18n()
const commandStore = useCommandStore()

/** 百分比乘子/上限（对齐 ProgressBar.vue 同名常量） */
const PERCENT_MULTIPLIER = 100
const PERCENT_MAX = 100
/** budget 百分比 severity 阈值（对齐 brief 的 budget 百分比阈值 70%/90%） */
const SEVERITY_THRESHOLD_WARN = 0.7
const SEVERITY_THRESHOLD_DANGER = 0.9

/** resolvedStatus：优先 goal.liveStatus（ANSI widget 实时），回退 stats-line 推断 */
const resolvedStatus = computed<GoalLiveStatus>(() => {
  if (props.goal.liveStatus) return props.goal.liveStatus
  return inferStatusFromGui(props.goal.gui)
})

const isBlocked = computed(() => resolvedStatus.value === 'blocked')

/**
 * card 容器 class（按 status 切 variant）：
 * · blocked → warning 边框（渐变背景由 __glow 层提供）
 * · complete → success 边框
 * · budget_limited / time_limited → danger 边框
 * · active / paused → default（border + surface）
 */
const cardClass = computed(() => {
  const s = resolvedStatus.value
  if (s === 'blocked') return 'border-warning bg-surface'
  if (s === 'complete') return 'border-success bg-surface'
  if (s === 'budget_limited' || s === 'time_limited') return 'border-danger bg-surface'
  return 'border-border bg-surface'
})

/** status 图标（语义化，克制使用） */
const statusIcon = computed<Component | null>(() => {
  switch (resolvedStatus.value) {
    case 'blocked':
      return AlertTriangle
    case 'complete':
      return CheckCircle
    case 'paused':
      return Pause
    case 'budget_limited':
      return Ban
    case 'time_limited':
      return Hourglass
    default:
      return null
  }
})

const statusIconClass = computed(() => {
  const s = resolvedStatus.value
  if (s === 'blocked') return 'text-warning'
  if (s === 'complete') return 'text-success'
  if (s === 'budget_limited' || s === 'time_limited') return 'text-danger'
  if (s === 'paused') return 'text-subtle'
  return 'text-accent'
})

/** status 徽章 class（soft 底 + 实色字） */
const badgeClass = computed(() => {
  const s = resolvedStatus.value
  if (s === 'blocked') return 'bg-warning-soft text-warning'
  if (s === 'complete') return 'bg-success-soft text-success'
  if (s === 'budget_limited' || s === 'time_limited') return 'bg-danger-soft text-danger'
  if (s === 'paused') return 'bg-surface-hover text-muted'
  return 'bg-accent-soft text-accent'
})

/** status 徽章文案（对齐 goal extension GoalStatus 枚举） */
const statusLabel = computed(() => {
  const map: Record<GoalLiveStatus, string> = {
    active: t('panel.panel.tasks.goalStatusActive'),
    blocked: t('panel.panel.tasks.goalStatusBlocked'),
    paused: t('panel.panel.tasks.goalStatusPaused'),
    complete: t('panel.panel.tasks.goalStatusComplete'),
    budget_limited: t('panel.panel.tasks.goalStatusBudgetLimited'),
    time_limited: t('panel.panel.tasks.goalStatusTimeLimited'),
  }
  return map[resolvedStatus.value]
})

/** slug 展示：优先 store 的 goal.slug，回退 card header */
const displaySlug = computed(() => {
  if (props.goal.slug) return props.goal.slug
  const gui = props.goal.gui
  if (gui?.type === 'card') {
    // card props.header 可能是 string 或 GuiComponent，只取 string 分支
    const header = (gui.props as { header?: string | GuiComponent }).header
    if (typeof header === 'string') return header
  }
  return ''
})

/** 预算耗尽/超时文案（budget_limited / time_limited 时显） */
const exhaustedHint = computed(() => {
  const s = resolvedStatus.value
  if (s === 'budget_limited') return t('panel.panel.tasks.tokenExhausted')
  if (s === 'time_limited') return t('panel.panel.tasks.timeExhausted')
  return ''
})

const exhaustedHintIcon = computed<Component>(() =>
  resolvedStatus.value === 'budget_limited' ? Ban : Hourglass,
)

interface ProgressBarItem {
  label: string
  /** CSS width 百分比字符串，如 '71.0%' */
  percent: string
  /** 形如 '71k/200k' 的数值串 */
  value: string
  /** Tailwind 填充色类 */
  fillClass: string
}

/**
 * 进度条提取：遍历 card body 找 type==='progress-bar' 的子组件。
 * 取 label/current/total/unit/severity，按 severity（live 字段优先）映射填充色。
 * 非 card 类型或无 progress-bar 子组件时返回空数组（不渲染进度条区）。
 */
const progressBars = computed<ProgressBarItem[]>(() => {
  const gui = props.goal.gui
  if (!gui || gui.type !== 'card') return []
  const bodyGui = (gui.props as { body?: GuiComponent[] }).body
  if (!Array.isArray(bodyGui)) return []
  const result: ProgressBarItem[] = []
  for (const child of bodyGui) {
    if (child.type !== 'progress-bar') continue
    // progress-bar props 结构已知（extension-protocol），用类型断言提取
    const p = child.props as {
      label?: string
      current: number
      total: number
      unit?: string
      severity?: 'ok' | 'warn' | 'danger'
    }
    const ratio = p.total > 0 ? p.current / p.total : 0
    const pct = `${Math.min(PERCENT_MAX, Math.max(0, ratio * PERCENT_MULTIPLIER)).toFixed(1)}%`
    result.push({
      label: p.label ?? '',
      percent: pct,
      value: `${p.current}${p.unit ?? ''}/${p.total}${p.unit ?? ''}`,
      fillClass: resolveFillClass(p.severity, ratio),
    })
  }
  return result
})

/**
 * severity → 填充色：
 * · 显式 severity 优先（ok→success / warn→warning / danger→danger）
 * · 无 severity：ratio ≥ 0.9 → danger，≥ 0.7 → warning，否则 accent
 *   （对齐 brief 的 budget 百分比阈值 70%/90%）
 */
function resolveFillClass(severity: 'ok' | 'warn' | 'danger' | undefined, ratio: number): string {
  if (severity === 'ok') return 'bg-success'
  if (severity === 'warn') return 'bg-warning'
  if (severity === 'danger') return 'bg-danger'
  if (ratio >= SEVERITY_THRESHOLD_DANGER) return 'bg-danger'
  if (ratio >= SEVERITY_THRESHOLD_WARN) return 'bg-warning'
  return 'bg-accent'
}

/**
 * 从 card GuiComponent 的 stats-line items 推断 status（liveStatus 缺失时的回退）。
 * goal extension buildGoalCard 的 stats-line 含 status 项（label='Status' 或 icon 标记），
 * 找 value 含 blocked/paused/complete 等关键词的 item。找不到回退 'active'。
 */
function inferStatusFromGui(gui: GuiComponent | undefined): GoalLiveStatus {
  if (!gui || gui.type !== 'card') return 'active'
  const bodyGui = (gui.props as { body?: GuiComponent[] }).body
  if (!Array.isArray(bodyGui)) return 'active'
  for (const child of bodyGui) {
    if (child.type !== 'stats-line') continue
    const items = (child.props as { items?: StatItem[] }).items
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const v = String(item.value ?? '').toLowerCase()
      if (/block/.test(v)) return 'blocked'
      if (/complete|done/.test(v)) return 'complete'
      if (/pause/.test(v)) return 'paused'
      if (/budget|token/.test(v)) return 'budget_limited'
      if (/time|timeout/.test(v)) return 'time_limited'
    }
  }
  return 'active'
}

/** Resume 按钮：走现有 slash 注入通道（commandStore.requestSlashInjection → Composer 注入 chip）。
 *  不开新口子（brief §7）。注入 /goal resume，由用户确认后发送。 */
function onResume(): void {
  if (!props.sessionId) return
  commandStore.requestSlashInjection({
    command: '/goal resume',
    sessionId: props.sessionId,
  })
}
</script>
