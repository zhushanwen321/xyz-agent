<script setup lang="ts">
defineProps<{
  variant: 'power' | 'efficient' | 'fast'
  active: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>

<template>
  <span
    :class="['s-tag-pill', `s-tag-pill--${variant}`, { active }]"
    @click="$emit('toggle')"
  >
    <slot />
  </span>
</template>
