<script setup lang="ts">
defineProps<{
  items: Array<{ key: string; value: string }>
}>()
</script>

<template>
  <div class="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 text-xs mb-3">
    <template v-for="item in items" :key="item.key">
      <span class="text-muted font-medium">{{ item.key }}</span>
      <span class="font-mono text-[11px] text-fg break-all">{{ item.value }}</span>
    </template>
  </div>
</template>
