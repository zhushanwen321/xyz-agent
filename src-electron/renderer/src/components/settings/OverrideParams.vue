<script setup lang="ts">
import { Input } from '../../design-system'

const props = defineProps<{
  active: boolean
  params: { depth: number; width: number; tokens: number; rounds: number }
}>()

const emit = defineEmits<{
  'update:active': [value: boolean]
  'update:params': [value: { depth: number; width: number; tokens: number; rounds: number }]
}>()

function update(key: string, val: string) {
  const num = Number(val)
  emit('update:params', { ...props.params, [key]: num })
}
</script>

<template>
  <div class="mt-3 pt-3 border-t border-border">
    <div
      :class="['flex items-center gap-2 text-xs text-muted cursor-pointer select-none', { 'text-accent': active }]"
      @click="$emit('update:active', !active)"
    >
      <span :class="['w-4 h-4 border rounded flex items-center justify-center transition-all duration-150 ease-ease', active ? 'bg-accent border-accent text-white text-[10px]' : 'border-border']">{{ active ? '\u2713' : '' }}</span>
      覆盖全局 SubAgent 参数
    </div>
    <div :class="['grid grid-cols-4 gap-2 mt-2', { 'opacity-40 pointer-events-none': !active }]">
      <div>
        <div class="text-[10px] text-muted mb-[3px]">深度</div>
        <Input
          class="w-full py-[5px] px-2 border border-border rounded bg-bg text-fg font-mono text-xs outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(params.depth)"
          @update:model-value="update('depth', $event)"
        />
      </div>
      <div>
        <div class="text-[10px] text-muted mb-[3px]">宽度</div>
        <Input
          class="w-full py-[5px] px-2 border border-border rounded bg-bg text-fg font-mono text-xs outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(params.width)"
          @update:model-value="update('width', $event)"
        />
      </div>
      <div>
        <div class="text-[10px] text-muted mb-[3px]">Token</div>
        <Input
          class="w-full py-[5px] px-2 border border-border rounded bg-bg text-fg font-mono text-xs outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(params.tokens)"
          @update:model-value="update('tokens', $event)"
        />
      </div>
      <div>
        <div class="text-[10px] text-muted mb-[3px]">轮次</div>
        <Input
          class="w-full py-[5px] px-2 border border-border rounded bg-bg text-fg font-mono text-xs outline-none transition-[border-color] duration-150 ease-ease focus:border-accent"
          :model-value="String(params.rounds)"
          @update:model-value="update('rounds', $event)"
        />
      </div>
    </div>
  </div>
</template>

