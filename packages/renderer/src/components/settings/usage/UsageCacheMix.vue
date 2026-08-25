<!--
  UsageCacheMix · 缓存构成：命中/新输入/输出 百分比构成条。
-->
<template>
  <div class="flex flex-col gap-3">
    <!-- 每个 model 一行 -->
    <div v-for="row in cacheData" :key="row.model" class="flex flex-col gap-1.5">
      <!-- 模型名 + 命中率 -->
      <div class="flex items-center justify-between gap-2">
        <span class="min-w-0 truncate font-[var(--font-mono)] text-[12px] text-[var(--neutral-fg)]">{{ row.model }}</span>
        <span class="shrink-0 font-[var(--font-mono)] text-[11px] tabular-nums text-[var(--neutral-dim)]">
          <span class="mr-1 text-[10px] text-[var(--neutral-dim)]">{{ t('settings.usage.cacheHitRate') }}</span>{{ fmtPct(row.hitRate) }}
        </span>
      </div>

      <!-- 三段构成条 -->
      <div class="h-2 overflow-hidden rounded-[3px] bg-[var(--hairline)]">
        <div class="flex h-full">
          <span
            class="h-full shrink-0"
            :style="{ width: (row.hit * 100).toFixed(2) + '%', background: 'var(--cache-hit)' }"
          />
          <span
            class="h-full shrink-0"
            :style="{ width: (row.newIn * 100).toFixed(2) + '%', background: 'var(--cache-in)' }"
          />
          <span
            class="h-full shrink-0"
            :style="{ width: (row.out * 100).toFixed(2) + '%', background: 'var(--cache-out)' }"
          />
        </div>
      </div>
    </div>

    <!-- 底部图例 -->
    <div class="mt-1 flex items-center gap-4 text-[11px] text-[var(--neutral-dim)]">
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-2.5 rounded-[2px]" style="background: var(--cache-hit)" />
        <span>{{ t('settings.usage.legendCacheHit') }}</span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-2.5 rounded-[2px]" style="background: var(--cache-in)" />
        <span>{{ t('settings.usage.legendNewInput') }}</span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block size-2.5 rounded-[2px]" style="background: var(--cache-out)" />
        <span>{{ t('settings.usage.legendOutput') }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { fmtPct } from './aggregate'

const { t } = useI18n()

defineProps<{
  cacheData: { model: string; hit: number; newIn: number; out: number; hitRate: number }[]
}>()
</script>
