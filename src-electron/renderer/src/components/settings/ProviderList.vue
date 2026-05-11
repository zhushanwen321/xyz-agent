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

function statusClass(status: ProviderInfo['status']) {
  switch (status) {
    case 'connected': return 'provider-card__status--on'
    case 'error': return 'provider-card__status--error'
    default: return 'provider-card__status--off'
  }
}

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
  <div class="provider-list">
    <!-- Section: 已配置的供应商 -->
    <div class="settings-section">
      <div class="settings-section__title">已配置的供应商</div>

      <!-- Loading -->
      <div v-if="loading" class="provider-list__loading">加载中…</div>

      <!-- Empty -->
      <div v-else-if="providers.length === 0" class="provider-list__empty">暂无已配置的供应商</div>

      <!-- Provider cards -->
      <template v-else>
        <div
          v-for="provider in sorted"
          :key="provider.id"
          class="provider-card"
          @click="emit('edit', provider.id)"
        >
          <span class="provider-card__name">{{ provider.name }}</span>
          <span v-if="provider.models.length" class="provider-card__models">{{ formatModels(provider.models) }}</span>
          <span class="provider-card__status" :class="statusClass(provider.status)">
            {{ statusLabel(provider.status) }}
          </span>
        </div>
      </template>
    </div>

    <!-- Section: 默认供应商配置 -->
    <div class="settings-section">
      <div class="settings-section__title">默认供应商配置</div>
      <div class="info-row">
        <span class="info-row__label">默认模型</span>
        <span class="info-row__value">claude-sonnet @ anthropic</span>
      </div>
      <div class="info-row">
        <span class="info-row__label">思考模式</span>
        <span class="info-row__value">high</span>
      </div>
      <div class="info-row">
        <span class="info-row__label">温度</span>
        <span class="info-row__value">0.7</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.provider-list {
  display: flex;
  flex-direction: column;
}

/* Loading & empty states */
.provider-list__loading,
.provider-list__empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}

/* Reuse design system classes for settings-section, provider-card, info-row */
.settings-section {
  margin-bottom: 28px;
}

.settings-section__title {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 12px;
}

.provider-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
  transition: border-color 0.15s var(--ease);
  transition: border-color 0.15s var(--ease);
  cursor: pointer;
}

.provider-card:hover {
  border-color: var(--accent);
}

.provider-card__name {
  font-weight: 600;
  font-size: 14px;
  flex: 1;
}

.provider-card__models {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--font-mono);
}

.provider-card__status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 100px;
  font-weight: 600;
}

.provider-card__status--on {
  background: var(--success-light);
  color: var(--success);
}

.provider-card__status--error {
  background: var(--danger-light);
  color: var(--danger);
}

.provider-card__status--off {
  background: var(--border);
  color: var(--muted);
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.info-row:last-child {
  border-bottom: none;
}

.info-row__label {
  color: var(--muted);
}

.info-row__value {
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
