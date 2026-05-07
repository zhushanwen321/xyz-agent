<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProviderInfo } from '@xyz-agent/shared'
import { Button, Badge } from '../../design-system'

const props = defineProps<{
  providers: ProviderInfo[]
  loading: boolean
}>()

const emit = defineEmits<{
  edit: [providerId: string]
  delete: [providerId: string]
  add: []
}>()

const { t } = useI18n()

const sorted = computed(() => {
  const STATUS_ORDER: Record<string, number> = { connected: 0, error: 1, not_configured: 2 }
  const UNKNOWN_STATUS_ORDER = STATUS_ORDER.not_configured + 1
  return [...props.providers].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? UNKNOWN_STATUS_ORDER) - (STATUS_ORDER[b.status] ?? UNKNOWN_STATUS_ORDER),
  )
})

function badgeVariant(status: ProviderInfo['status']) {
  switch (status) {
    case 'connected': return 'success'
    case 'error': return 'danger'
    default: return 'idle'
  }
}

function statusLabel(status: ProviderInfo['status']) {
  switch (status) {
    case 'connected': return t('settings.connected')
    case 'error': return t('settings.error')
    default: return t('settings.notConfigured')
  }
}
</script>

<template>
  <div class="provider-list">
    <div class="provider-list__header">
      <h3 class="provider-list__title">{{ t('settings.providers') }}</h3>
      <Button variant="primary" size="sm" @click="emit('add')">
        {{ t('settings.addProvider') }}
      </Button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="provider-list__empty">
      <span class="provider-list__loading">{{ t('common.loading') }}</span>
    </div>

    <!-- Empty -->
    <div v-else-if="providers.length === 0" class="provider-list__empty">
      <span class="provider-list__empty-text">{{ t('settings.addProvider') }}</span>
    </div>

    <!-- List -->
    <ul v-else class="provider-list__items">
      <li
        v-for="provider in sorted"
        :key="provider.id"
        class="provider-list__item"
      >
        <div class="provider-list__info">
          <span class="provider-list__name">{{ provider.name }}</span>
          <Badge :variant="badgeVariant(provider.status)" dot>
            {{ statusLabel(provider.status) }}
          </Badge>
          <span v-if="provider.models.length" class="provider-list__models">
            {{ provider.models.join(', ') }}
          </span>
        </div>
        <div class="provider-list__actions">
          <Button variant="ghost" size="sm" @click="emit('edit', provider.id)">
            {{ t('common.edit') }}
          </Button>
          <Button variant="danger" size="sm" @click="emit('delete', provider.id)">
            {{ t('common.delete') }}
          </Button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.provider-list {
  display: flex;
  flex-direction: column;
  gap: var(--radius-md, 8px);
}

.provider-list__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.provider-list__title {
  font-size: var(--font-lg, 1.125rem);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
}

.provider-list__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  color: var(--color-text-muted);
}

.provider-list__loading,
.provider-list__empty-text {
  font-size: var(--font-sm, 0.875rem);
}

.provider-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--radius-sm, 4px);
}

.provider-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--radius-md, 8px) var(--radius-lg, 12px);
  border-radius: var(--radius-md, 8px);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
}

.provider-list__info {
  display: flex;
  align-items: center;
  gap: var(--radius-md, 8px);
  min-width: 0;
  flex: 1;
}

.provider-list__name {
  font-size: var(--font-sm, 0.875rem);
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
}

.provider-list__models {
  font-size: var(--font-xs, 0.75rem);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-list__actions {
  display: flex;
  align-items: center;
  gap: var(--radius-xs, 4px);
  flex-shrink: 0;
}
</style>
