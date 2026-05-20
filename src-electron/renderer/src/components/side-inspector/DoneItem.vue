<template>
  <div class="border border-[oklch(80%_0.02_145)] rounded-sm mb-2 overflow-hidden bg-[oklch(97%_0.015_145)]">
    <div class="py-[10px] px-3 flex items-center gap-2">
      <span class="w-[7px] h-[7px] rounded-full bg-success shrink-0"></span>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-semibold">{{ name }}</div>
        <div class="text-xs text-muted mt-[2px] line-clamp-2">{{ summary }}</div>
      </div>
      <div v-if="duration" class="text-[10px] text-muted whitespace-nowrap text-right">{{ duration }}</div>
    </div>
    <div class="px-3 pb-[10px]">
      <span class="text-xs text-accent font-semibold cursor-pointer hover:underline" @click="$emit('view')">查看详情 →</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  id: string
  name: string
  summary: string
  duration?: string
}>()

defineEmits<{
  view: []
}>()
</script>
