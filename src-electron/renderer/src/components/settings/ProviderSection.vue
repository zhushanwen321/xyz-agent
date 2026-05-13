<script setup lang="ts">
import { computed } from 'vue'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { Button } from '../../design-system'
import { ToggleSwitch } from './shared'
import ModelRow from './ModelRow.vue'

const props = defineProps<{
  provider: ProviderInfo
  models: ModelInfo[]
}>()

defineEmits<{
  'toggle-enabled': [providerId: string]
  'toggle-model': [providerId: string, modelId: string]
  edit: [providerId: string]
  delete: [providerId: string]
}>()

const initial = computed(() => props.provider.name.charAt(0).toUpperCase())

const statusDotClass = computed(() => {
  const map: Record<string, string> = {
    connected: 'bg-[var(--success)]',
    error: 'bg-[var(--danger)]',
    not_configured: 'bg-border',
  }
  return map[props.provider.status] ?? 'bg-border'
})

const modelCount = computed(() => props.models.length)
</script>

<template>
  <div
    :class="[
      'border border-border rounded-lg overflow-hidden mb-3 transition-all duration-150 hover:border-[oklch(86%_0.012_70)]',
      { 'opacity-50': provider.enabled === false },
    ]"
  >
    <!-- Header -->
    <div class="flex items-center gap-3 py-[9px] px-4 bg-[var(--section-bg)] min-h-[42px]">
      <ToggleSwitch
        :model-value="provider.enabled !== false"
        @update:model-value="$emit('toggle-enabled', provider.id)"
        @click.stop
      />
      <div
        class="w-[30px] h-[30px] rounded-[5px] bg-[var(--accent-light)] flex items-center justify-center font-display font-bold text-sm text-[var(--accent)] shrink-0"
      >{{ initial }}</div>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-semibold flex items-center gap-1.5">
          {{ provider.name }}
          <span :class="['w-[7px] h-[7px] rounded-full inline-block', statusDotClass]" />
        </div>
        <div class="text-[11px] text-muted font-mono mt-px truncate">{{ provider.baseUrl }}</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0" @click.stop>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">{{ modelCount }} models</span>
        <Button variant="ghost" size="sm" @click="$emit('edit', provider.id)">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="$emit('delete', provider.id)">删除</Button>
      </div>
    </div>

    <!-- Body: model rows -->
    <div>
      <ModelRow
        v-for="model in models"
        :key="model.id"
        :name="model.name"
        :ctx="model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : '--'"
        :tags="model.tags ?? []"
        :enabled="model.enabled !== false"
        @toggle-enabled="$emit('toggle-model', provider.id, model.id)"
      />
    </div>
  </div>
</template>
