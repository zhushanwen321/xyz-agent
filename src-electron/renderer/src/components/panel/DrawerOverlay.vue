<template>
  <div class="drawer-overlay" :class="{ visible }" @click="$emit('close')"></div>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
}>()

defineEmits<{
  close: []
}>()
</script>
