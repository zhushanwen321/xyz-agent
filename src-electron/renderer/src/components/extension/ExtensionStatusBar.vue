<script setup lang="ts">
defineProps<{
  statusKey: string
  text: string
}>()
</script>

<template>
  <span class="inline-flex items-center gap-1 text-[10px] text-muted" :title="statusKey">
    {{ text }}
  </span>
</template>
