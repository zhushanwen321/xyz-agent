<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  percentage: number
}>()

const barColor = computed(() => {
  if (props.percentage >= 90) return 'bg-accent-red'
  if (props.percentage >= 70) return 'bg-accent-yellow'
  return 'bg-accent'
})
</script>

<template>
  <div class="flex items-center gap-1.5">
    <div class="h-1 w-[60px] rounded-full bg-border-default">
      <div
        class="h-full rounded-full transition-all duration-300 ease-out"
        :class="barColor"
        :style="{ width: `${Math.min(percentage, 100)}%` }"
      />
    </div>
    <span class="font-mono text-[10px] text-text-tertiary">{{ percentage.toFixed(0) }}%</span>
  </div>
</template>
