<script setup lang="ts">
import { computed } from 'vue'
import type { MockProvider, MockModel } from '../../mock/data'
import { ToggleSwitch } from './shared'
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
  'toggle-enabled': [id: string]
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
      <ToggleSwitch
        :model-value="provider.status === 'connected'"
        @update:model-value="$emit('toggle-enabled', provider.id)"
        @click.stop
      />
      <div class="provider-card__info">
        <div class="provider-card__name">
          <span :class="['status-dot', statusDotClass]"></span>
          {{ provider.name }}
        </div>
        <div class="provider-card__meta">{{ provider.baseUrl }} · {{ provider.models.length }} 个模型</div>
      </div>
      <div class="provider-card__actions" @click.stop>
        <!-- Test connection -->
        <button class="icon-btn" title="测试连接" @click="$emit('test', provider.id)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        </button>
        <!-- Edit -->
        <button class="icon-btn" title="编辑" @click="$emit('edit', provider.id)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <!-- Delete -->
        <button class="icon-btn icon-btn--danger" title="删除" @click="$emit('delete', provider.id)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
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
  margin-bottom: 12px;
  overflow: hidden;
  transition: border-color 0.2s var(--ease);
}
.provider-card:hover { border-color: oklch(80% 0.01 70); }

.provider-card__hd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  cursor: pointer;
  user-select: none;
}
.provider-card__info { flex: 1; min-width: 0; }
.provider-card__name {
  font-size: 14px;
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
.provider-card__actions { display: flex; gap: 2px; flex-shrink: 0; }
.provider-card__bd { padding: 0 18px 16px; display: none; }
.provider-card.expanded .provider-card__bd { display: block; }
.provider-card__models { margin-top: 4px; }

/* Status dots */
.status-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; vertical-align: middle; }
.status-dot--ok { background: var(--success); }
.status-dot--err { background: var(--danger); }
.status-dot--unknown { background: var(--border); }

/* Icon buttons */
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-xs);
  border: none; background: transparent; color: var(--muted);
  cursor: pointer; transition: all 0.15s var(--ease);
}
.icon-btn svg { width: 15px; height: 15px; }
.icon-btn:hover { background: var(--accent-light); color: var(--accent); }
.icon-btn--danger:hover { background: var(--danger-light); color: var(--danger); }

/* Section divider */
.section-divider {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted);
  margin: 16px 0 10px; padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
</style>
