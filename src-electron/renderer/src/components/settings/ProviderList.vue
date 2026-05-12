<script setup lang="ts">
import { computed } from 'vue'
import type { ProviderInfo } from '@xyz-agent/shared'

const props = defineProps<{
  providers: ProviderInfo[]
  loading: boolean
}>()

const emit = defineEmits<{
  edit: [providerId: string]
  delete: [providerId: string]
  add: []
}>()

const sorted = computed(() => {
  const STATUS_ORDER: Record<string, number> = { connected: 0, error: 1, not_configured: 2 }
  const UNKNOWN_STATUS_ORDER = STATUS_ORDER.not_configured + 1
  return [...props.providers].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? UNKNOWN_STATUS_ORDER) - (STATUS_ORDER[b.status] ?? UNKNOWN_STATUS_ORDER),
  )
})

function statusLabel(status: ProviderInfo['status']) {
  switch (status) {
    case 'connected': return '已连接'
    case 'error': return '错误'
    default: return '未配置'
  }
}

function formatModels(models: string[]) {
  return models.join(', ')
}
</script>

<template>
  <div class="flex flex-col">
    <!-- Section: 已配置的供应商 -->
    <div class="mb-7">
      <div class="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted mb-3">已配置的供应商</div>

      <!-- Loading -->
      <div v-if="loading" class="py-6 text-center text-[13px] text-muted">加载中…</div>

      <!-- Empty -->
      <div v-else-if="providers.length === 0" class="py-6 text-center text-[13px] text-muted">暂无已配置的供应商</div>

      <!-- Provider cards -->
      <template v-else>
        <div
          v-for="provider in sorted"
          :key="provider.id"
          class="flex items-center gap-3 py-3 px-[14px] bg-surface border border-border rounded-sm mb-2 cursor-pointer transition-colors duration-150 ease-ease hover:border-accent"
          @click="emit('edit', provider.id)"
        >
          <span class="font-semibold text-sm flex-1">{{ provider.name }}</span>
          <span v-if="provider.models.length" class="text-[11px] text-muted font-mono">{{ formatModels(provider.models) }}</span>
          <span
            class="text-[11px] py-[2px] px-2 rounded-full font-semibold"
            :class="{
              'bg-success-light text-success': provider.status === 'connected',
              'bg-danger-light text-danger': provider.status === 'error',
              'bg-border text-muted': provider.status === 'not_configured'
            }"
          >
            {{ statusLabel(provider.status) }}
          </span>
        </div>
      </template>
    </div>

    <!-- Section: 默认供应商配置 -->
    <div class="mb-7">
      <div class="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted mb-3">默认供应商配置</div>
      <div class="flex justify-between items-center py-[6px] text-[13px] border-b border-border">
        <span class="text-muted">默认模型</span>
        <span class="font-mono text-xs">claude-sonnet @ anthropic</span>
      </div>
      <div class="flex justify-between items-center py-[6px] text-[13px] border-b border-border">
        <span class="text-muted">思考模式</span>
        <span class="font-mono text-xs">high</span>
      </div>
      <div class="flex justify-between items-center py-[6px] text-[13px] border-b-0">
        <span class="text-muted">温度</span>
        <span class="font-mono text-xs">0.7</span>
      </div>
    </div>
  </div>
</template>

