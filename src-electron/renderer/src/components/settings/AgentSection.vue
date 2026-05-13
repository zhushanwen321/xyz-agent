<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AgentInfo } from '@xyz-agent/shared'
import { Button, Select } from '../../design-system'
import { ToggleSwitch } from './shared'

const props = defineProps<{
  agent: AgentInfo
  allModels: Array<{ id: string; name: string; providerName: string }>
}>()

const emit = defineEmits<{
  'toggle-enabled': []
  'update-strategy': [payload: { agentId: string; strategy: string }]
  delete: [agentId: string]
}>()

const showConfirm = ref(false)

const initial = computed(() => (props.agent.icon ?? props.agent.name.charAt(0)).toUpperCase())

const strategyLabel = computed(() => {
  if (props.agent.modelStrategy === 'auto') return 'auto'
  if (props.agent.modelStrategy === 'tag') return 'tag'
  if (props.agent.modelStrategy === 'bind') return 'bind'
  return 'auto'
})

const strategyOptions = [
  { label: 'auto — 自动匹配', value: 'auto' },
  { label: 'tag — 按标签', value: 'tag' },
  { label: 'bind — 绑定', value: 'bind' },
]

const sourceSubtitle = computed(() => {
  const path = props.agent.source ?? props.agent.id
  return `${strategyLabel.value} · ${path}`
})

function onStrategyChange(val: string) {
  emit('update-strategy', { agentId: props.agent.id, strategy: val })
}

function handleDeleteClick() {
  showConfirm.value = true
}

function confirmDelete() {
  emit('delete', props.agent.id)
}

function cancelDelete() {
  showConfirm.value = false
}
</script>

<template>
  <div
    :class="[
      'border border-border rounded-lg overflow-hidden mb-3 transition-all duration-150 hover:border-[oklch(86%_0.012_70)]',
      { 'opacity-60': !agent.enabled },
    ]"
  >
    <!-- Header -->
    <div class="flex items-center gap-3 py-[9px] px-4 bg-[var(--section-bg)] min-h-[42px]">
      <ToggleSwitch
        :model-value="agent.enabled"
        @update:model-value="$emit('toggle-enabled')"
        @click.stop
      />
      <div
        class="w-[30px] h-[30px] rounded-[5px] flex items-center justify-center font-bold text-sm shrink-0"
        :style="agent.iconBg ? { background: agent.iconBg, color: 'var(--accent)' } : { background: 'var(--accent-light)', color: 'var(--accent)' }"
      >{{ initial }}</div>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-semibold">{{ agent.name }}</div>
        <div class="text-[11px] text-muted font-mono mt-px truncate">{{ sourceSubtitle }}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0" @click.stop>
        <Button variant="ghost" size="sm">编辑</Button>
        <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="handleDeleteClick">删除</Button>
      </div>
    </div>

    <!-- Confirm bar -->
    <div v-if="showConfirm" class="flex items-center gap-2 py-2 px-4 bg-[var(--danger-light)] text-xs text-[var(--danger)]">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="5.5" /><path d="M7 4.5v3M7 9v.5" />
      </svg>
      确认删除 {{ agent.name }}？此操作不可撤销。
      <Button variant="ghost" size="sm" class="!bg-[var(--danger)] !text-white hover:!opacity-80 !py-[3px] !px-2 !text-[11px] !rounded-[3px] !border-none" @click="confirmDelete">确认删除</Button>
      <Button variant="ghost" size="sm" class="!text-[var(--danger)] !py-[3px] !px-2 !text-[11px]" @click="cancelDelete">取消</Button>
    </div>

    <!-- Body -->
    <div>
      <div class="flex items-center gap-3 py-2 px-4 border-b border-[var(--divider)]">
        <span class="text-xs font-medium min-w-[76px]">模型策略</span>
        <Select
          :model-value="strategyLabel"
          :options="strategyOptions"
          class="flex-1 !h-7 !px-2.5 !py-1 !text-xs !rounded"
          @update:model-value="onStrategyChange"
        />
      </div>
      <div v-if="agent.tools && agent.tools.length > 0" class="flex items-center gap-3 py-2 px-4">
        <span class="text-xs font-medium min-w-[76px]">工具</span>
        <span class="font-mono text-[11px]">{{ agent.tools.join(', ') }}</span>
      </div>
    </div>
  </div>
</template>
