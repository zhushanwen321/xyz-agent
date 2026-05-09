<script setup lang="ts">
import { computed } from 'vue'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { Button } from '../../design-system'
import { ToggleSwitch } from './shared'
import ModelRow from './ModelRow.vue'

interface Props {
  provider: ProviderInfo
  models: ModelInfo[]
  expanded?: boolean
}

const props = defineProps<Props>()

defineEmits<{
  toggle: []
  edit: [id: string]
  delete: [id: string]
  test: [id: string]
  'toggle-enabled': [id: string]
  'toggle-model': [providerId: string, modelId: string]
}>()

const initial = computed(() => props.provider.name.charAt(0).toUpperCase())

const statusDotClass = computed(() => {
  const statusMap: Record<string, string> = {
    connected: 's-status-dot--ok',
    error: 's-status-dot--err',
    not_configured: 's-status-dot--unknown',
  }
  return statusMap[props.provider.status] ?? 's-status-dot--unknown'
})
</script>

<template>
  <div :class="['s-provider-card', { expanded }]">
    <div class="s-provider-card__hd" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="provider.status === 'connected'"
        @update:model-value="$emit('toggle-enabled', provider.id)"
        @click.stop
      />
      <div class="s-provider-card__icon">{{ initial }}</div>
      <div class="s-provider-card__info">
        <div class="s-provider-card__name">
          <span :class="['s-status-dot', statusDotClass]"></span>
          {{ provider.name }}
        </div>
        <div class="s-provider-card__meta">{{ provider.baseUrl }} · {{ provider.models.length }} 个模型</div>
      </div>
      <div class="s-provider-card__actions" @click.stop>
        <Button variant="ghost" size="sm" @click="$emit('test', provider.id)">测试连接</Button>
        <Button variant="ghost" size="sm" @click="$emit('edit', provider.id)">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!border-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', provider.id)">删除</Button>
      </div>
      <span class="s-provider-card__chevron">▾</span>
    </div>
    <div class="s-provider-card__bd">
      <div class="s-divider" style="margin-top: 0">模型配置</div>
      <div class="s-provider-card__models">
        <ModelRow
          v-for="model in models"
          :key="model.id"
          :name="model.name"
          :ctx="model.contextWindow ? `${model.contextWindow} ctx` : '--'"
          :tags="model.tags ?? []"
          :enabled="model.enabled !== false"
          @toggle-enabled="$emit('toggle-model', provider.id, model.id)"
        />
      </div>
    </div>
  </div>
</template>
