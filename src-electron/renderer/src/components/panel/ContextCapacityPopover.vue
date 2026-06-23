<template>
  <!--
    §2a 上下文容量 popover（draft-composer-states §2a）。
    hover 触发，按钮文字始终显当前用量摘要（6.9万 · 6.9%），浮层给完整容量。
    用量分档：<70% accent · 70–90% warning · >90% danger（bar）。
    缓存命中：≥50% success · <50% warning。
  -->
  <HoverCard>
    <HoverCardTrigger>
      <Button
        variant="ghost"
        :class="
          cn(
            'h-7 gap-[5px] rounded-sm px-2 text-[11.5px] transition-colors',
            isHigh ? 'text-warning hover:text-warning' : 'text-subtle hover:text-muted',
          )
        "
        title="上下文容量"
      >
        <span class="tabular-nums">{{ usedWan }}</span>
        <span aria-hidden="true">·</span>
        <span class="tabular-nums">{{ stats.percent }}%</span>
      </Button>
    </HoverCardTrigger>
    <HoverCardContent side="top" class="w-[260px] p-0">
      <!-- head -->
      <div
        class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
      >
        <span>上下文容量</span>
        <span>{{ stats.modelId }}</span>
      </div>
      <!-- bar -->
      <div class="mx-2.5 mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          :class="cn('h-full rounded-full transition-all', barClass)"
          :style="{ width: `${stats.percent}%` }"
        />
      </div>
      <!-- stats -->
      <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">已用</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ usedWan }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">总量</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ totalWan }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">使用率</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ stats.percent }}%</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">缓存命中</span>
          <span
            :class="cn('font-sans text-[14px] font-semibold tabular-nums', cacheHitClass)"
          >{{ stats.cacheHit }}%</span>
        </div>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import * as events from '@/api/events'

interface ContextStats {
  used: number
  total: number
  percent: number
  cacheHit: number
  modelId: string
}

// 初始值用原 fixture 数值（context.update payload 未契约化，第4项 4e；订阅骨架先建）
const stats = ref<ContextStats>({
  used: 69000,
  total: 1000000,
  percent: 6.9,
  cacheHit: 98.7,
  modelId: 'claude-sonnet-4.5',
})

let unsubContext: (() => void) | null = null
onMounted(() => {
  unsubContext = events.onGlobalType('context.update', () => {
    // TODO(第4项 4e): payload 结构契约化后解析 msg.payload 填充 stats
  })
})
onBeforeUnmount(() => { unsubContext?.() })

// 阈值常量（避免 magic number）
const WAN_UNIT = 10_000
const HIGH_THRESHOLD = 70 // >70% warning（按钮 + 条）
const DANGER_THRESHOLD = 90 // >90% 条转 danger
const CACHE_LOW_THRESHOLD = 50 // <50% 缓存命中转 warning

/**
 * token 数 → 「万」格式：除 10000 加「万」后缀，保留 1 位小数（整数去 .0）。
 * 69000 → 6.9万 · 1000000 → 100万
 */
function formatWan(n: number): string {
  const wan = n / WAN_UNIT
  return `${wan.toFixed(1).replace(/\.0$/, '')}万`
}

const usedWan = computed(() => formatWan(stats.value.used))
const totalWan = computed(() => formatWan(stats.value.total))

const isHigh = computed(() => stats.value.percent > HIGH_THRESHOLD)
const isDanger = computed(() => stats.value.percent > DANGER_THRESHOLD)

const barClass = computed(() => {
  if (isDanger.value) return 'bg-danger'
  if (isHigh.value) return 'bg-warning'
  return 'bg-gradient-to-r from-accent to-accent-hover'
})

const cacheHitClass = computed(() =>
  stats.value.cacheHit < CACHE_LOW_THRESHOLD ? 'text-warning' : 'text-success',
)
</script>
