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

<style scoped>
.drawer-overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.15);
  z-index: 40;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s var(--ease, ease);
}
.drawer-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}
</style>
