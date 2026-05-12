<script setup lang="ts">
import { Input } from '../../design-system'

const props = defineProps<{
  modelValue: { depth: number; width: number; tokens: number; rounds: number }
}>()

const emit = defineEmits<{
  'update:modelValue': [value: { depth: number; width: number; tokens: number; rounds: number }]
}>()

function update(key: string, val: string) {
  const num = Number(val)
  emit('update:modelValue', { ...props.modelValue, [key]: num })
}
</script>

<template>
  <div class="py-4 mb-6">
    <div class="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted mb-3.5 pb-1.5 border-b border-border flex items-center gap-1.5">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="w-3.5 h-3.5 text-muted">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5M8 10.5v.5" />
      </svg>
      SubAgent 默认参数
    </div>
    <div class="grid grid-cols-4 gap-3">
      <div class="param-item">
        <div class="text-[11px] text-muted mb-1 font-medium">最大深度</div>
        <Input
          class="w-full py-1.5 px-2.5 border border-border rounded bg-bg text-fg font-mono text-[13px] outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(modelValue.depth)"
          @update:model-value="update('depth', $event)"
        />
      </div>
      <div class="param-item">
        <div class="text-[11px] text-muted mb-1 font-medium">最大宽度</div>
        <Input
          class="w-full py-1.5 px-2.5 border border-border rounded bg-bg text-fg font-mono text-[13px] outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(modelValue.width)"
          @update:model-value="update('width', $event)"
        />
      </div>
      <div class="param-item">
        <div class="text-[11px] text-muted mb-1 font-medium">Token 上限</div>
        <Input
          class="w-full py-1.5 px-2.5 border border-border rounded bg-bg text-fg font-mono text-[13px] outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(modelValue.tokens)"
          @update:model-value="update('tokens', $event)"
        />
      </div>
      <div class="param-item">
        <div class="text-[11px] text-muted mb-1 font-medium">最大轮次</div>
        <Input
          class="w-full py-1.5 px-2.5 border border-border rounded bg-bg text-fg font-mono text-[13px] outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(modelValue.rounds)"
          @update:model-value="update('rounds', $event)"
        />
      </div>
    </div>
  </div>
</template>


