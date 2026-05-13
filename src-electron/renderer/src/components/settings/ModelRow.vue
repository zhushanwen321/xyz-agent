<script setup lang="ts">
import { TagPill } from './shared'

defineProps<{
  name: string
  ctx: string
  tags: string[]
}>()

const allTags = ['power', 'efficient', 'fast'] as const
</script>

<template>
  <div class="flex items-center gap-2.5 py-[9px] px-4 rounded-sm mb-1 transition-colors duration-100 hover:bg-bg">
    <span class="font-mono text-[13px] font-semibold flex-1 min-w-0 truncate">{{ name }}</span>
    <span class="text-[11px] text-muted font-mono whitespace-nowrap min-w-[60px] text-right">{{ ctx }}</span>
    <div class="flex gap-1 shrink-0">
      <TagPill
        v-for="tag in allTags"
        :key="tag"
        :variant="tag"
        :active="tags.includes(tag)"
        readonly
      >{{ tag }}</TagPill>
    </div>
  </div>
</template>
