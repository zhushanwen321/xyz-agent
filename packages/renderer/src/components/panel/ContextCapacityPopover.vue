<template>
  <!--
    §2a 上下文容量 popover + coding-plan 额度（draft-composer-states §2a + merged-card）。
    hover 触发，按钮文字始终显当前用量摘要（6.9万 · 6.9%），浮层给完整容量。
    用量分档：<70% accent · 70–90% warning · >90% danger（bar）。
    缓存命中：≥50% success · <50% warning。

    coding-plan 区（w4 新增）：
    - divider + section label + provider tag
    - 3 窗口行（4 列 grid：label | bar | pct | reset）
    - ∞ 窗口（pct=null）整行隐藏
    - 未配置 provider：只保留容量区，footer 显配置提示
    - hover-enter 触发 quota 查询（先 cached 后 fetch）
  -->
  <HoverCard>
    <HoverCardTrigger as-child>
      <Button
        variant="ghost"
        :class="
          cn(
            'h-7 gap-1 rounded-sm px-2 text-[11px] transition-colors',
            isHigh ? 'text-warning hover:text-warning' : 'text-subtle hover:text-muted',
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
        class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
      >
        <span>{{ t('panel.context.capacity') }}</span>
        <span>{{ stats.modelId ?? '—' }}</span>
      </div>
      <!-- bar（仅 contextWindow 已知时显示） -->
      <div v-if="hasPercent" class="mx-2.5 mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          :class="cn('h-full rounded-full transition-all', barClass)"
          :style="{ width: `${stats.percent}%` }"
        />
      </div>
      <!-- stats -->
      <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">{{ t('panel.context.used') }}</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ usedDisplay }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">{{ t('panel.context.total') }}</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ hasPercent ? totalDisplay : t('panel.context.unknown') }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">{{ t('panel.context.usageRate') }}</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ hasPercent ? `${stats.percent}%` : '—' }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">{{ t('panel.context.cacheHit') }}</span>
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
          <div class="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-subtle">
            <span>Coding Plan</span>
            <span
              v-if="matchedPresetLabel"
              :class="cn(
                'rounded-sm px-1 py-px text-[9px] font-semibold tracking-[0.03em]',
                quotaDanger ? 'bg-danger-soft text-danger' : quotaWarning ? 'bg-warning-soft text-warning' : 'bg-accent-soft text-accent',
              )"
            >{{ matchedPresetLabel }}</span>
          </div>

          <!-- 3 窗口行（4 列 grid） -->
          <template v-if="quotaRow">
            <div
              v-for="(win, idx) in visibleWindows"
              :key="idx"
              class="grid items-center py-0.5"
              style="grid-template-columns: 32px 1fr 32px 52px; column-gap: 8px; font-size: 11px; line-height: 1.4;"
            >
              <span class="font-sans text-[10.5px] text-muted">{{ windowLabels[win.idx] }}</span>
              <div class="relative h-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  :class="cn('h-full rounded-full transition-all', win.pct >= DANGER_THRESHOLD ? 'bg-danger' : win.pct >= HIGH_THRESHOLD ? 'bg-warning' : 'bg-gradient-to-r from-accent to-accent-hover')"
                  :style="{ width: `${win.pct}%` }"
                />
              </div>
              <span
                :class="cn(
                  'text-right font-semibold tabular-nums',
                  win.pct >= DANGER_THRESHOLD ? 'text-danger' : win.pct >= HIGH_THRESHOLD ? 'text-warning' : 'text-fg',
                )"
              >{{ win.pct }}%</span>
              <span class="truncate text-right font-mono text-[9.5px] tabular-nums text-subtle">
                {{ formatReset(win.resetSec) }}
              </span>
            </div>
          </template>

          <!-- 无数据时的占位 -->
          <div v-else class="py-1.5 text-center text-[10.5px] text-subtle">
            {{ quotaStore.isPending(matchedProviderId) ? '查询中...' : '暂无额度数据' }}
          </div>
        </div>
      </template>

      <!-- footer -->
      <div class="flex items-center justify-between border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-subtle">
        <span v-if="matchedProviderId && lastFetchAt">
          {{ formatLastFetch(lastFetchAt) }}
        </span>
        <span v-else-if="matchedProviderId">
          无 Coding Plan 数据
        </span>
        <span v-else>
          {{ t('panel.context.noCodingPlan') }}
        </span>
        <Button
          v-if="matchedProviderId"
          variant="secondary"
          class="h-5 rounded-sm px-1.5 font-mono text-[9.5px]"
          :disabled="quotaStore.isPending(matchedProviderId)"
          @click.stop="onRefresh"
        >
          {{ quotaStore.isPending(matchedProviderId) ? '...' : '刷新' }}
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
import { computed, ref, toRef, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'
import { matchQuotaPreset, QUOTA_PRESETS } from '@xyz-agent/shared'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
import { useSessionStore } from '@/stores/session'
import { useSettingsStore } from '@/stores/settings'
import { useQuotaStore } from '@/stores/quota'
import { useQuotaQuery } from '@/composables/features/useQuotaQuery'

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
  /** session 通道订阅键（D8：context.update 带 sessionId，走 events.on(sessionId)） */
  sessionId?: string
}>()

// ── stores ──
const sessionStore = useSessionStore()
const settingsStore = useSettingsStore()
const quotaStore = useQuotaStore()

// Settings 模态框打开（AppShell 经 provide('openSettings') 注入；未提供时 no-op）。
// 未配置态「配置 Coding Plan」按钮跳转 Settings → Provider 页（偏差 #D）。
const openSettings = inject<() => void>('openSettings', () => {})

// ── session 事件订阅（context.update + session.state_changed）──

/**
 * 订阅 context.update + session.state_changed（D8：session 通道）。
 * 字段映射（D9）：used←inputTokens / total←contextLimit / percent←usagePercent。
 * cacheHit / modelId 无来源，保持占位。sessionId 变化时重订。
 *
 * 显隐策略：hasUsage（used>0）控制按钮可见——agent 跑过即显示用量；
 * hasPercent（total>0）控制百分比/进度条——provider 配了 contextWindow 才显示百分比，
 * 否则只显「已用 X 万」不带百分比（contextLimit=0 不再隐藏整个组件）。
 *
 * session.state_changed：模型切换后 runtime 推送（含按新 contextWindow 重算的用量），
 * 使用量随模型切换立即刷新，无需等下一次 agent_end。
 *
 * 订阅编排（重订 / 退订）归 useSessionEvents（features 层），本组件只声明 type 白名单 + handler。
 */
const onMessage = useSessionEvents(toRef(props, 'sessionId'))
onMessage(['context.update', 'session.state_changed'], (msg) => {
  // 多 type handler：payload 仍为联合宽类型（context.update 与 session.state_changed 结构不同，
  // 无法静态收窄为单一类型），按契约窄断言取共用三字段（见 protocol.ts ServerMessageMap）
  const { inputTokens, contextLimit, usagePercent } = msg.payload as {
    sessionId: string; usagePercent: number; inputTokens: number; contextLimit: number
  }
  stats.value = {
    ...stats.value,
    used: inputTokens,
    total: contextLimit,
    percent: usagePercent,
  }
})

// ── coding-plan 额度查询（w4 新增）──

/**
 * 从当前 session 的 modelId 派生 providerId（复合串 "provider/modelId" → provider 部分），
 * 然后匹配 quota preset，命中则启用 coding-plan 区。
 */
const matchedProviderId = computed<string | null>(() => {
  const sid = props.sessionId
  if (!sid) return null
  const session = sessionStore.list.find((s) => s.id === sid)
  if (!session?.modelId) return null
  const provider = session.modelId.split('/')[0]
  if (!provider) return null

  // 在 settingsStore.providers 中找到该 provider
  const providerInfo = settingsStore.providers.find((p) => p.id === provider)
  if (!providerInfo) return null

  // 检查是否有 quota 配置且已启用
  if (!providerInfo.quota?.enabled) return null

  return provider
})

/** 匹配到的 quota preset 的显示名（基于手动指定的 quota.fetcher，fallback 到自动匹配）。 */
const matchedPresetLabel = computed<string | null>(() => {
  const pid = matchedProviderId.value
  if (!pid) return null
  const providerInfo = settingsStore.providers.find((p) => p.id === pid)
  if (!providerInfo) return null
  // 优先用手动指定的 fetcher 查 label，fallback 到自动匹配
  const manualFetcher = providerInfo.quota?.fetcher
  const preset = manualFetcher
    ? QUOTA_PRESETS.find((p) => p.fetcher === manualFetcher)
    : matchQuotaPreset({ baseUrl: providerInfo.baseUrl, name: providerInfo.name })
  return preset?.label ?? null
})

/** useQuotaQuery 控制器（hover-enter 查询逻辑）。 */
const { data: quotaData, lastFetchAt, onHoverEnter: queryOnHoverEnter } = useQuotaQuery(matchedProviderId)

/** 额度数据（NormalizedQuotaRow | null）。 */
const quotaRow = computed<NormalizedQuotaRow | null>(() => quotaData.value)

// ── 窗口标签 ──
const WINDOW_LABELS = ['5h', '本周', '本月'] as const
const windowLabels: readonly string[] = WINDOW_LABELS

// ── 分档阈值（复用现有规则）──
const HIGH_THRESHOLD = 70
const DANGER_THRESHOLD = 90

/**
 * 过滤 ∞ 窗口（pct=null 整行隐藏），返回可见窗口列表。
 * 每项带原始索引（idx）和 pct（非 null，已确认）。
 */
interface VisibleWindow {
  idx: number
  pct: number
  resetSec: number | null
}

const visibleWindows = computed<VisibleWindow[]>(() => {
  const row = quotaRow.value
  if (!row) return []
  return row.wins
    .map((w, i) => (w.pct != null ? { idx: i, pct: w.pct, resetSec: w.resetSec } : null))
    .filter((w): w is VisibleWindow => w != null)
})

/** 是否有高用量窗口（>=70%）。 */
const quotaWarning = computed(() => visibleWindows.value.some((w) => w.pct >= HIGH_THRESHOLD && w.pct < DANGER_THRESHOLD))
const quotaDanger = computed(() => visibleWindows.value.some((w) => w.pct >= DANGER_THRESHOLD))

// ── 时间格式化 ──

/** 格式化剩余秒数为人类可读文案。
 * null → "--"；≥86400 → "Xd Yh"；≥3600 → "Xh Ym"；≥60 → "Xm"；<60 → "<1m"。
 */
const SEC_PER_DAY = 86400
const SEC_PER_HOUR = 3600
const SEC_PER_MIN = 60
function formatReset(sec: number | null): string {
  if (sec == null) return '--'
  if (sec <= 0) return '--'
  const d = Math.floor(sec / SEC_PER_DAY)
  const h = Math.floor((sec % SEC_PER_DAY) / SEC_PER_HOUR)
  const m = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN)
  if (d > 0) return `剩${d}d${h}h`
  if (h > 0) return `剩${h}h${m}m`
  if (m > 0) return `剩${m}m`
  return '<1m'
}

/** 格式化 lastFetchAt 为相对时间。 */
const MS_PER_SEC = 1000
const MIN_PER_HOUR = 60
const HOUR_PER_DAY = 24
function formatLastFetch(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / MS_PER_SEC)
  if (sec < SEC_PER_MIN) return '刚刚更新'
  const m = Math.floor(sec / SEC_PER_MIN)
  if (m < MIN_PER_HOUR) return `${m} 分钟前更新`
  const h = Math.floor(m / MIN_PER_HOUR)
  if (h < HOUR_PER_DAY) return `${h} 小时前更新`
  const d = Math.floor(h / HOUR_PER_DAY)
  return `${d} 天前更新`
}

// ── hover-enter 查询触发 ──

/**
 * hover 进入浮层时触发查询。
 * 流程：先 getCached 即时填充 → 再 fetch 触发查询。
 * 并发保护由 quotaStore.pending Set + useQuotaQuery 保证。
 */
function onHoverEnter(): void {
  if (matchedProviderId.value) {
    // fire-and-forget：查询结果写入 store，组件通过 computed 自动响应式刷新
    void queryOnHoverEnter()
  }
}

/** 刷新按钮点击。 */
function onRefresh(): void {
  if (matchedProviderId.value) {
    void queryOnHoverEnter()
  }
}

// ── 现有容量区计算（保持不变）──

// 阈值常量（避免 magic number）
const CACHE_LOW_THRESHOLD = 50 // <50% 缓存命中转 warning

/**
 * token 数 → 「K/M」格式：<K_THRESHOLD 显原数；≥K_THRESHOLD 显 K（1 位小数，整数去 .0）；≥M_THRESHOLD 显 M。
 * 820 → 820 · 69000 → 69K · 1630000 → 1.6M
 */
const K_THRESHOLD = 1000
const M_THRESHOLD = 1_000_000
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

/** 是否已有 usage 数据（收到过 context.update，agent 跑过即 true）；推送前隐藏整个组件 */
const hasUsage = computed(() => stats.value.used > 0)
/** 是否能算百分比（provider 配了 contextWindow）；否则只显已用量不显百分比 */
const hasPercent = computed(() => stats.value.total > 0)

const isHigh = computed(() => stats.value.percent > HIGH_THRESHOLD)
const isDanger = computed(() => stats.value.percent > DANGER_THRESHOLD)

const barClass = computed(() => {
  if (isDanger.value) return 'bg-danger'
  if (isHigh.value) return 'bg-warning'
  return 'bg-gradient-to-r from-accent to-accent-hover'
})

const cacheHitClass = computed(() => {
  const hit = stats.value.cacheHit
  if (hit == null) return 'text-subtle'
  return hit < CACHE_LOW_THRESHOLD ? 'text-warning' : 'text-success'
})
</script>
