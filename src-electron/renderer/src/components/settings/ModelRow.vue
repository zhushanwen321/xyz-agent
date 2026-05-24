<script setup lang="ts">

defineProps<{
  name: string
  ctx: string
}>()
</script>

<template>
  <div class="flex items-center gap-2.5 py-[9px] px-4 rounded-sm mb-1 transition-colors duration-100 hover:bg-bg">
    <span class="font-mono text-[13px] font-semibold flex-1 min-w-0 truncate">{{ name }}</span>
    <span class="text-[11px] text-muted font-mono whitespace-nowrap min-w-[60px] text-right">{{ ctx }}</span>
  </div>
</template>
