<template>
  <div class="absolute inset-0 bg-black/15 z-40 opacity-0 pointer-events-none transition-opacity duration-[250ms] ease-ease" :class="{ 'opacity-100 pointer-events-auto': visible }" @click="$emit('close')"></div>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
}>()

defineEmits<{
  close: []
}>()
</script>
