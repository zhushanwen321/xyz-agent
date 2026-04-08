<script setup lang="ts">
defineProps<{
  isStreaming: boolean
  modelName: string
}>()
</script>

<template>
  <div class="flex items-center justify-between border-t bg-muted/30 px-4 py-1 text-xs text-muted-foreground">
    <span>{{ modelName }}</span>
    <span v-if="isStreaming" class="flex items-center gap-1">
      <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
      生成中...
    </span>
    <span v-else>就绪</span>
  </div>
</template>
