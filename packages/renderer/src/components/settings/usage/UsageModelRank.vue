<!--
  UsageModelRank · 模型谱排名条形列表。
  点击行 toggle isolate（单看某模型），选中行 model 名变 accent 色。
-->
<template>
  <div data-testid="usage-model-rank" class="flex flex-col">
    <div
      v-for="(row, i) in sortedRows"
      :key="row.model"
      data-testid="usage-model-row"
      class="grid cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto_80px_56px] items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 transition-colors hover:bg-[var(--row-hover)]"
      :class="{ 'bg-[var(--accent-soft)]': isolate === row.model }"
      @click="toggle(row.model)"
    >
      <!-- 序号 -->
      <span class="w-6 shrink-0 text-right text-[11px] font-medium text-[var(--neutral-dim)] tabular-nums">
        {{ String(i + 1).padStart(2, '0') }}
      </span>

      <!-- 模型名 -->
      <span class="min-w-0 truncate font-[var(--font-mono)] text-[12px]" :class="isolate === row.model ? 'text-[var(--accent)]' : 'text-[var(--neutral-fg)]'">
        <span class="text-[var(--neutral-dim)]">{{ row.provider }}/</span>{{ row.model }}
      </span>

      <!-- 条形图 -->
      <span class="bar-track relative mx-2 h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-[3px] bg-[var(--hairline)]">
        <span
          class="absolute inset-y-0 left-0 rounded-[3px]"
          :style="{ width: maxVal > 0 ? (row.value / maxVal * 100).toFixed(1) + '%' : '0%', background: getProviderColor(row.provider) }"
        />
      </span>

      <!-- 数值 -->
      <span class="w-20 shrink-0 text-right font-[var(--font-mono)] text-[12px] tabular-nums text-[var(--neutral-fg)]">
        <template v-if="metric === 'cost'">{{ fmtUSD(row.value) }}<span v-if="row.tokenVal > 0" class="ml-1 text-[10px] text-[var(--neutral-dim)]">{{ fmtCompact(row.tokenVal) }}</span></template>
        <template v-else>{{ fmtCompact(row.value) }}<span v-if="row.costVal > 0" class="ml-1 text-[10px] text-[var(--neutral-dim)]">{{ fmtUSD(row.costVal) }}</span></template>
      </span>

      <!-- 占比 -->
      <span class="w-14 shrink-0 text-right font-[var(--font-mono)] text-[11px] tabular-nums text-[var(--neutral-dim)]">
        {{ fmtPct(totalVal > 0 ? row.value / totalVal : 0) }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  getProviderColor,
  metricValue,
  fmtCompact,
  fmtUSD,
  fmtPct,
  totalTokens,
} from './aggregate'
import type { AggMetrics } from './aggregate'

const props = defineProps<{
  perModel: Record<string, AggMetrics>
  metric: 'tokens' | 'cost'
  isolate: string | null
  modelProviderMap: Record<string, string>
}>()

const emit = defineEmits<{
  'update:isolate': [model: string | null]
}>()

interface ModelRow {
  model: string
  provider: string
  value: number
  tokenVal: number
  costVal: number
}

const TOP_MODELS = 8

const sortedRows = computed<ModelRow[]>(() => {
  const ALLOWED_KEYS = Object.keys(props.perModel)
  return Object.entries(props.perModel)
    .filter(([k]) => ALLOWED_KEYS.includes(k))
    .map(([model, u]) => ({
      model,
      provider: props.modelProviderMap[model] ?? 'unknown',
      value: metricValue(u, props.metric),
      tokenVal: totalTokens(u),
      costVal: u.cost,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_MODELS)
})

const maxVal = computed(() => sortedRows.value[0]?.value ?? 0)

const totalVal = computed(() =>
  Object.values(props.perModel).reduce((sum, u) => sum + metricValue(u, props.metric), 0),
)

function toggle(model: string): void {
  emit('update:isolate', props.isolate === model ? null : model)
}
</script>

