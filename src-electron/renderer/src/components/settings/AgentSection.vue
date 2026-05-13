<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AgentInfo } from '@xyz-agent/shared'
import { Button } from '../../design-system'
import { ToggleSwitch } from './shared'

const props = defineProps<{
  agent: AgentInfo
}>()

const emit = defineEmits<{
  'toggle-enabled': []
  edit: []
  delete: [agentId: string]
}>()

const showConfirm = ref(false)

const initial = computed(() => (props.agent.icon ?? props.agent.name.charAt(0)).toUpperCase())

const sourceSubtitle = computed(() => props.agent.source ?? props.agent.id)

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
      'border-b border-[var(--divider)] last:border-b-0 transition-colors duration-120',
      { 'opacity-60': !agent.enabled },
    ]"
  >
    <!-- Header -->
    <div class="flex items-center gap-3 py-[9px] px-4 min-h-[42px] hover:bg-[var(--hover-bg)]">
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
        <Button variant="ghost" size="sm" @click="$emit('edit')">编辑</Button>
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
  </div>
</template>
