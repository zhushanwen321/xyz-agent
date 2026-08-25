<!--
  UsageLedger · 摘要台账行。
  一行内联数字，竖 hairline 分隔。从 demo ledger 移植。
-->
<template>
  <div data-testid="usage-ledger" class="flex flex-wrap gap-y-[18px]">
    <!-- 总 Token（lead 大字） -->
    <div data-testid="usage-ledger-total-tokens" class="pr-7 mr-7 border-r border-[var(--hairline)] last:border-r-0 last:mr-0 last:pr-0">
      <div class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.totalTokens') }} &middot; {{ range === 0 ? t('settings.usage.rangeAll') : t('settings.usage.recentDays', { n: nDays }) }}</div>
      <div class="font-mono tabular-nums text-[24px] font-medium leading-[1.35] text-[var(--neutral-fg)]">
        {{ fmtInt(totalTokens(tot)) }}
      </div>
    </div>

    <!-- 费用 -->
    <div data-testid="usage-ledger-cost" class="pr-7 mr-7 border-r border-[var(--hairline)] last:border-r-0 last:mr-0 last:pr-0">
      <div class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.cost') }}</div>
      <div
        class="font-mono tabular-nums text-[21px] font-medium leading-[1.35]"
        :class="tot.cost === 0 ? 'text-[var(--neutral-dim)]' : 'text-[var(--neutral-fg)]'"
      >
        {{ tot.cost === 0 ? '\u2014' : fmtUSD(tot.cost) }}
      </div>
    </div>

    <!-- 消息数 -->
    <div class="pr-7 mr-7 border-r border-[var(--hairline)] last:border-r-0 last:mr-0 last:pr-0">
      <div class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.messages') }}</div>
      <div class="font-mono tabular-nums text-[21px] font-medium leading-[1.35] text-[var(--neutral-fg)]">
        {{ fmtInt(msgs) }}
      </div>
    </div>

    <!-- 活跃天 -->
    <div class="pr-7 mr-7 border-r border-[var(--hairline)] last:border-r-0 last:mr-0 last:pr-0">
      <div class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.activeDays') }}</div>
      <div class="font-mono tabular-nums text-[21px] font-medium leading-[1.35] text-[var(--neutral-fg)]">
        {{ activeDays }} / {{ nDays }}
      </div>
    </div>

    <!-- 缓存命中率 -->
    <div class="pr-7 mr-7 border-r border-[var(--hairline)] last:border-r-0 last:mr-0 last:pr-0">
      <div class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.cacheHitRate') }}</div>
      <div class="font-mono tabular-nums text-[21px] font-medium leading-[1.35] text-[var(--neutral-fg)]">
        {{ cacheHitRate }}
      </div>
    </div>

    <!-- 峰值日 -->
    <div class="pr-7 mr-7 border-r border-[var(--hairline)] last:border-r-0 last:mr-0 last:pr-0">
      <div class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.peakDay') }}</div>
      <div class="font-mono tabular-nums text-[21px] font-medium leading-[1.35] text-[var(--neutral-fg)]">
        {{ peak.d ? fmtMMDD(toLocalDate(peak.d)) : '\u2014' }}
      </div>
      <div v-if="peak.d" class="font-mono text-[11px] text-[var(--neutral-dim)]">
        {{ metric === 'tokens' ? fmtCompact(peak.v) : fmtUSD(peak.v) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  type AggMetrics,
  fmtInt,
  fmtCompact,
  fmtUSD,
  fmtPct,
  totalTokens,
  fmtMMDD,
  toLocalDate,
} from './aggregate'

const { t } = useI18n()

const props = defineProps<{
  tot: AggMetrics
  msgs: number
  activeDays: number
  nDays: number
  peak: { v: number; d: string | null }
  range: number
  metric: 'tokens' | 'cost'
}>()

const cacheHitRate = computed(() => {
  const base = props.tot.cacheRead + props.tot.input
  return base > 0 ? fmtPct(props.tot.cacheRead / base) : '\u2014'
})
</script>
