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
        v-show="hasData"
        variant="ghost"
        :class="
          cn(
            'h-7 gap-1 rounded-sm px-2 text-[11.5px] transition-colors',
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
        <span>{{ stats.modelId ?? '—' }}</span>
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
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ hasData ? usedWan : '—' }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">总量</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ hasData ? totalWan : '—' }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">使用率</span>
          <span class="font-sans text-[14px] font-semibold tabular-nums text-fg">{{ hasData ? `${stats.percent}%` : '—' }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-subtle">缓存命中</span>
          <span
            :class="cn('font-sans text-[14px] font-semibold tabular-nums', cacheHitClass)"
          >{{ stats.cacheHit != null ? `${stats.cacheHit}%` : '—' }}</span>
        </div>
      </div>
    </HoverCardContent>
  </HoverCard>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { useSessionEvents } from '@/composables/features/useSessionEvents'

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

const props = defineProps<{
  /** session 通道订阅键（D8：context.update 带 sessionId，走 events.on(sessionId)） */
  sessionId?: string
}>()

/**
 * 订阅 context.update + session.state_changed（D8：session 通道）。
 * 字段映射（D9）：used←inputTokens / total←contextLimit / percent←usagePercent。
 * cacheHit / modelId 无来源，保持占位。sessionId 变化时重订。
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

/** 是否已收到 context.update（total>0 判定）；推送前关键数字显「—」 */
const hasData = computed(() => stats.value.total > 0)

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
