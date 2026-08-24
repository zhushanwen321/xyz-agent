<template>
  <!--
    §2a 上下文容量 popover + coding-plan 额度（draft-composer-states §2a + merged-card）。
    hover 触发，按钮文字始终显当前用量摘要（6.9万 · 6.9%），浮层给完整容量。
    用量分档：<70% accent · 70–90% warning · >90% danger（bar）。
    缓存命中：≥50% success · <50% warning。

    coding-plan 区：逻辑在 useQuotaDisplay composable，本组件纯展示。
  -->
  <HoverCard>
    <HoverCardTrigger as-child>
      <Button
        variant="ghost"
        :class="
          cn(
            'h-7 gap-1 rounded-sm px-2 text-[11px] transition-colors',
            isHigh ? 'text-warn hover:text-warn' : 'text-neutral-dim hover:text-neutral-mid',
          )
        "
        :title="t('panel.context.capacity')"
        @mouseenter="onHoverEnter"
      >
        <span class="tabular-nums">{{ hasUsage ? usedDisplay : '—' }}</span>
        <template v-if="hasPercent">
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">{{ stats.percent }}%</span>
        </template>
      </Button>
    </HoverCardTrigger>
    <HoverCardContent
      side="top"
      class="w-[260px] p-0"
    >
      <!-- head -->
      <div
        class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
      >
        <span>{{ t('panel.context.capacity') }}</span>
        <span>{{ stats.modelId ?? '—' }}</span>
      </div>
      <!-- bar（仅 contextWindow 已知时显示） -->
      <div v-if="hasPercent" class="mx-2.5 mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          :class="cn('h-full rounded-full transition-[width,background-color]', barClass)"
          :style="{ width: `${stats.percent}%` }"
        />
      </div>
      <!-- stats -->
      <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.used') }}</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-neutral-fg">{{ usedDisplay }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.total') }}</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-neutral-fg">{{ hasPercent ? totalDisplay : t('panel.context.unknown') }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.usageRate') }}</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-neutral-fg">{{ hasPercent ? `${stats.percent}%` : '—' }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.cacheHit') }}</span>
          <span
            :class="cn('font-sans text-[14px] font-semibold tabular-nums', cacheHitClass)"
          >{{ stats.cacheHit != null ? `${stats.cacheHit}%` : '—' }}</span>
        </div>
      </div>

      <!-- coding-plan 区（仅 provider 命中 quota preset 时显示） -->
      <template v-if="matchedProviderId">
        <div class="mx-2.5 h-px bg-border" />
        <div class="px-2.5 pt-2">
          <!-- section label + provider tag -->
          <div class="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-neutral-dim">
            <span>Coding Plan</span>
            <span
              v-if="matchedPresetLabel"
              :class="cn(
                'rounded-sm px-1 py-px text-[9px] font-semibold tracking-[0.03em]',
                quotaDanger ? 'bg-danger-soft text-danger' : quotaWarning ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent',
              )"
            >{{ matchedPresetLabel }}</span>
          </div>

          <!-- 查询失败提示（B2：区分「从未查询」vs「查询失败」） -->
          <div v-if="error" class="py-1.5 text-center text-[10.5px] text-danger">
            {{ t('panel.context.queryFailed', { error }) }}
          </div>

          <!-- 3 窗口行（4 列 grid） -->
          <template v-else-if="quotaRow">
            <div
              v-for="(win, idx) in visibleWindows"
              :key="idx"
              class="grid items-center py-0.5"
              style="grid-template-columns: 32px 1fr 32px 52px; column-gap: 8px; font-size: 11px; line-height: 1.4;"
            >
              <span class="font-sans text-[10.5px] text-neutral-mid">{{ windowLabels[win.idx] }}</span>
              <div class="relative h-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  :class="cn('h-full rounded-full transition-[width,background-color]', win.pct >= DANGER_THRESHOLD ? 'bg-danger' : win.pct >= HIGH_THRESHOLD ? 'bg-warn' : 'bg-gradient-to-r from-accent to-accent-hover')"
                  :style="{ width: `${win.pct}%` }"
                />
              </div>
              <span
                :class="cn(
                  'text-right font-semibold tabular-nums',
                  win.pct >= DANGER_THRESHOLD ? 'text-danger' : win.pct >= HIGH_THRESHOLD ? 'text-warn' : 'text-neutral-fg',
                )"
              >{{ win.pct }}%</span>
              <span class="truncate text-right font-mono text-[9.5px] tabular-nums text-neutral-dim">
                {{ formatReset(win.resetSec) }}
              </span>
            </div>
          </template>

          <!-- 无数据时的占位 -->
          <div v-else class="py-1.5 text-center text-[10.5px] text-neutral-dim">
            {{ isPending ? t('panel.context.quotaQuerying') : t('panel.context.noQuotaData') }}
          </div>
        </div>
      </template>

      <!-- footer -->
      <div class="flex items-center justify-between border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
        <span v-if="matchedProviderId && lastFetchAt">
          {{ formatLastFetch(lastFetchAt) }}
        </span>
        <span v-else-if="matchedProviderId">
          {{ t('panel.context.noCodingPlanData') }}
        </span>
        <span v-else>
          {{ t('panel.context.noCodingPlan') }}
        </span>
        <Button
          v-if="matchedProviderId"
          variant="secondary"
          class="h-5 rounded-sm px-1.5 font-mono text-[9.5px]"
          :disabled="refreshing"
          @click.stop="onRefresh"
        >
          {{ refreshing ? t('panel.context.refreshing') : t('panel.context.refresh') }}
        </Button>
        <!-- 未配置态：显示「配置」按钮跳转 Settings（偏差 #D） -->
        <Button
          v-else
          variant="secondary"
          class="h-5 rounded-sm px-1.5 font-mono text-[9.5px]"
          @click.stop="openSettings"
        >
          {{ t('panel.context.configureCodingPlan') }}
        </Button>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { ref, computed, toRef, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { useQuotaStore } from '@/stores/quota'
import { useQuotaDisplay } from '@/composables/features/model/useQuotaDisplay'
import { quotaFailReasonText } from '@/composables/features/model/useQuotaQuery'
import * as quotaApi from '@/api/domains/quota'

interface ContextStats {
  used: number
  total: number
  percent: number
  cacheHit: number | null
  modelId: string | null
}

// 初始全 0/null：未收到 context.update 推送前不显示假数字（hasData=false 时关键数字显「—」）。
// cacheHit / modelId 无 runtime 来源（D9）：保持 null，UI 显「—」。
const stats = ref<ContextStats>({
  used: 0,
  total: 0,
  percent: 0,
  cacheHit: null,
  modelId: null,
})

const { t } = useI18n()

const props = defineProps<{
  /** session 通道订阅键（context.update 带 sessionId，走 events.on(sessionId)） */
  sessionId?: string
  /**
   * 当前复合 modelId（"provider/modelId"），受控 prop，由 Composer 下发。
   * landing 态由 Composer 经 useComposerModelThinking fallback 到 defaultModel。
   * 用于推导 provider（split('/')[0]）查 quota——不在子组件内自查 sessionStore，
   * 对齐 ModelSelectPopover/ThinkingLevelPopover 的受控范式。
   */
  modelId?: string
}>()

const quotaStore = useQuotaStore()

// Settings 模态框打开（AppShell 经 provide('openSettings') 注入；未提供时 no-op）。
// 未配置态「配置 Coding Plan」按钮跳转 Settings → Provider 页（偏差 #D）。
const openSettings = inject<() => void>('openSettings', () => {})

// ── session 事件订阅（context.update）──
// 字段映射（D9）：used←inputTokens / total←contextLimit / percent←usagePercent。
// cacheHit / modelId 无来源，保持占位。sessionId 变化时重订。
// [Phase 1 最小适配，D1 协议收敛] session.state_changed 已不携带 usage 三字段——本订阅
// 退订 state_changed，只订 context.update；三字段 optional（字段缺失 = 无值，如 compact 后
// 占位帧），缺失时跳过更新保持旧值。完整重构（useContextUsage 分区 composable）是 Phase 2。
const onMessage = useSessionEvents(toRef(props, 'sessionId'))
onMessage('context.update', (msg) => {
  const { inputTokens, contextLimit, usagePercent } = msg.payload
  if (inputTokens === undefined || contextLimit === undefined || usagePercent === undefined) return
  // taste:allow-instance-level-session-state 理由：Phase 2 useContextUsage 重构迁移中，见 docs/todo/context-consistency-design.md D2
  stats.value = {
    ...stats.value,
    used: inputTokens,
    total: contextLimit,
    percent: usagePercent,
  }
})

// ── coding-plan 额度展示（逻辑抽到 useQuotaDisplay）──
const {
  matchedProviderId,
  matchedPresetLabel,
  quotaRow,
  lastFetchAt,
  error,
  isPending,
  visibleWindows,
  quotaWarning,
  quotaDanger,
  windowLabels,
  formatReset,
  formatLastFetch,
  onHoverEnter,
} = useQuotaDisplay(toRef(props, 'modelId'))

// 阈值常量（与 useQuotaDisplay 一致，模板分档用）
const HIGH_THRESHOLD = 70
const DANGER_THRESHOLD = 90

/** 刷新中（refreshQuota 路径独立于 hover-enter 的 isPending）。 */
const refreshing = ref(false)

/**
 * 刷新按钮点击（W1：改用 refreshQuota 绕过 10s throttle）。
 * 不走 onHoverEnter→fetchQuota（受 throttle，10s 内刷新拿缓存）。
 */
async function onRefresh(): Promise<void> {
  const pid = matchedProviderId.value
  if (!pid) return
  refreshing.value = true
  try {
    // refreshQuota 失败时 runtime 返回失败态（ok=true + data=null + reason，A2-4 契约），不抛错：
    // 带 reason → 保留旧 data、写 error 让 UI 显失败提示（与 useQuotaQuery 一致）；
    // rejected（连接层错误）同样保留旧 data 写 error
    const result = await quotaApi.refreshQuota(pid)
    if (result.reason) {
      quotaStore.setError(pid, quotaFailReasonText(result.reason))
    } else {
      quotaStore.setCache(pid, result.data, result.lastFetchAt)
    }
  } catch (e) {
    quotaStore.setError(pid, e instanceof Error ? e.message : String(e))
  } finally {
    refreshing.value = false
  }
}

// ── 现有容量区计算（保持不变）──

const CACHE_LOW_THRESHOLD = 50 // <50% 缓存命中转 warning
const K_THRESHOLD = 1000
const M_THRESHOLD = 1_000_000

/**
 * token 数 → 「K/M」格式：<K_THRESHOLD 显原数；≥K_THRESHOLD 显 K；≥M_THRESHOLD 显 M。
 */
function formatTokens(n: number): string {
  if (n < K_THRESHOLD) return String(n)
  if (n < M_THRESHOLD) {
    const k = n / K_THRESHOLD
    return `${k.toFixed(1).replace(/\.0$/, '')}K`
  }
  const m = n / M_THRESHOLD
  return `${m.toFixed(1).replace(/\.0$/, '')}M`
}

const usedDisplay = computed(() => formatTokens(stats.value.used))
const totalDisplay = computed(() => formatTokens(stats.value.total))

const hasUsage = computed(() => stats.value.used > 0)
const hasPercent = computed(() => stats.value.total > 0)

const isHigh = computed(() => stats.value.percent > HIGH_THRESHOLD)
const isDanger = computed(() => stats.value.percent > DANGER_THRESHOLD)

const barClass = computed(() => {
  if (isDanger.value) return 'bg-danger'
  if (isHigh.value) return 'bg-warn'
  return 'bg-gradient-to-r from-accent to-accent-hover'
})

const cacheHitClass = computed(() => {
  const hit = stats.value.cacheHit
  if (hit == null) return 'text-neutral-dim'
  return hit < CACHE_LOW_THRESHOLD ? 'text-warn' : 'text-success'
})

</script>
