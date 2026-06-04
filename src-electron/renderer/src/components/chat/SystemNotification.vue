<template>
  <div :class="['self-stretch w-full max-w-none my-2 border border-transparent rounded-none p-2.5 px-3.5 text-[13px] flex items-start gap-2.5 box-border', type === 'alert' ? 'bg-danger-light' : 'bg-success-light']">
    <span :class="['w-2 h-2 rounded-full shrink-0 mt-1', type === 'done' ? 'bg-success' : 'bg-danger']"></span>
    <div class="flex-1">
      <div class="font-semibold text-[13px] leading-snug mb-0.5">{{ title || content }}</div>
      <div v-if="description" class="text-muted text-xs leading-normal">{{ description }}</div>
      <span v-if="actionLabel" class="text-xs text-accent font-semibold cursor-pointer mt-1 inline-flex items-center gap-0.5 hover:underline" @click="$emit('action')">
        {{ actionLabel }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  type: 'done' | 'alert' | 'info'
  title: string
  content?: string
  description?: string
  actionLabel?: string
}>()

defineEmits<{
  action: []
}>()
</script>


