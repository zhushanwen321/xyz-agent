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
    connected: 'bg-success',
    error: 'bg-danger',
    not_configured: 'bg-border',
  }
  return statusMap[props.provider.status] ?? 'bg-border'
})
</script>

<template>
  <div class="bg-surface border border-border rounded mb-4 overflow-hidden transition-colors duration-200 hover:border-[oklch(80%_0.01_70)]">
    <div class="flex items-center gap-3 py-4 px-5 cursor-pointer select-none" @click="$emit('toggle')">
      <ToggleSwitch
        :model-value="provider.enabled !== false"
        @update:model-value="$emit('toggle-enabled', provider.id)"
      />
      <div class="w-9 h-9 rounded-sm bg-accent-light flex items-center justify-center font-display font-bold text-sm text-accent shrink-0">{{ initial }}</div>
      <div class="flex-1 min-w-0">
        <div class="text-[15px] font-semibold flex items-center gap-2">
          <span :class="['w-[7px] h-[7px] rounded-full inline-block align-middle', statusDotClass]"></span>
          {{ provider.name }}
        </div>
        <div class="text-xs text-muted mt-0.5 font-mono">{{ provider.baseUrl }} · {{ provider.models.length }} 个模型</div>
      </div>
      <div class="flex gap-1 shrink-0" @click.stop>
        <Button variant="ghost" size="sm" @click="$emit('test', provider.id)">测试连接</Button>
        <Button variant="ghost" size="sm" @click="$emit('edit', provider.id)">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', provider.id)">删除</Button>
      </div>
      <span :class="['text-[10px] text-muted transition-transform duration-200 ml-1', { 'rotate-180': expanded }]">▾</span>
    </div>
    <div v-show="expanded" class="px-5 pb-4">
      <div class="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted my-5 pb-1.5 border-b border-border" style="margin-top: 0">模型配置</div>
      <div class="mt-1">
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
