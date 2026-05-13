<script setup lang="ts">
import { ToggleSwitch, TagPill } from './shared'

interface Props {
  name: string
  ctx: string
  tags: string[]
  enabled: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  'toggle-enabled': []
}>()

const allTags = ['power', 'efficient', 'fast'] as const
</script>

<template>
  <div :class="['flex items-center gap-2.5 py-[9px] px-4 rounded-sm mb-1 transition-colors duration-100 hover:bg-bg', { 'opacity-50': !enabled }]" @click.stop>
    <div class="cursor-pointer flex items-center" @click="emit('toggle-enabled')">
      <ToggleSwitch :model-value="enabled" />
    </div>
    <span class="font-mono text-[13px] font-semibold flex-1 min-w-0 truncate">{{ name }}</span>
    <span class="text-[11px] text-muted font-mono whitespace-nowrap min-w-[60px] text-right">{{ ctx }}</span>
    <div class="flex gap-1 shrink-0">
      <TagPill
        v-for="tag in allTags"
        :key="tag"
        :variant="tag"
        :active="tags.includes(tag)"
        readonly
      >
        {{ tag === 'power' ? '\u5f3a\u529b' : tag === 'efficient' ? '\u9ad8\u6548' : '\u5feb\u901f' }}
      </TagPill>
    </div>
  </div>
</template>
