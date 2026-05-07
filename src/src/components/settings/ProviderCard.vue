<script setup lang="ts">
import { computed } from 'vue'
import type { MockProvider, MockModel } from '../../mock/data'
import ModelRow from './ModelRow.vue'

interface Props {
  provider: MockProvider
  models: MockModel[]
  expanded?: boolean
}

const props = defineProps<Props>()

defineEmits<{
  toggle: []
  edit: [id: string]
  delete: [id: string]
  test: [id: string]
}>()

const statusDotClass = computed(() => {
  const statusMap: Record<string, string> = {
    connected: 'status-dot--ok',
    error: 'status-dot--err',
    not_configured: 'status-dot--unknown',
  }
  return statusMap[props.provider.status] ?? 'status-dot--unknown'
})
</script>

<template>
  <div :class="['provider-card', { expanded }]">
    <div class="provider-card__hd" @click="$emit('toggle')">
      <div class="provider-card__icon">{{ provider.icon }}</div>
      <div class="provider-card__info">
        <div class="provider-card__name">
          <span :class="['status-dot', statusDotClass]"></span>
          {{ provider.name }}
        </div>
        <div class="provider-card__meta">{{ provider.baseUrl }} · {{ provider.models.length }} 个模型</div>
      </div>
      <div class="provider-card__actions" @click.stop>
        <button class="btn btn--ghost btn--sm" @click="$emit('test', provider.id)">测试连接</button>
        <button class="btn btn--ghost btn--sm" @click="$emit('edit', provider.id)">编辑</button>
        <button class="btn btn--ghost btn--sm btn--danger" @click="$emit('delete', provider.id)">删除</button>
      </div>
    </div>
    <div class="provider-card__bd">
      <div class="section-divider">模型配置</div>
      <div class="provider-card__models">
        <ModelRow
          v-for="model in models"
          :key="model.id"
          :name="model.name"
          :ctx="model.ctx + ' ctx'"
          :tags="model.tags"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.provider-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 16px;
  overflow: hidden;
  transition: border-color 0.2s var(--ease);
}

.provider-card:hover {
  border-color: oklch(80% 0.01 70);
}

.provider-card__hd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  cursor: pointer;
  user-select: none;
}

.provider-card__icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--accent-light);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 14px;
  color: var(--accent);
  flex-shrink: 0;
}

.provider-card__info {
  flex: 1;
  min-width: 0;
}

.provider-card__name {
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-card__meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  font-family: var(--font-mono);
}

.provider-card__actions {
  display: flex;
  gap: 4px;
}

.provider-card__bd {
  padding: 0 20px 16px;
  display: none;
}

.provider-card.expanded .provider-card__bd {
  display: block;
}

.provider-card__models {
  margin-top: 4px;
}

/* Status dots */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  vertical-align: middle;
}

.status-dot--ok {
  background: var(--success);
}

.status-dot--err {
  background: var(--danger);
}

.status-dot--unknown {
  background: var(--border);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.2s var(--ease);
  white-space: nowrap;
}

.btn:hover {
  background: var(--accent-light);
  color: var(--accent);
  border-color: var(--accent);
}

.btn--sm {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: var(--radius-xs);
}

.btn--danger:hover {
  background: var(--danger-light);
  color: var(--danger);
  border-color: var(--danger);
}

.btn--ghost {
  border: none;
  color: var(--muted);
  padding: 5px 8px;
}

.btn--ghost:hover {
  color: var(--accent);
  background: var(--accent-light);
}

/* Section divider */
.section-divider {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 20px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
</style>
