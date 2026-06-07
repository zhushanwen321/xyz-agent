<template>
  <div
    :class="['loading-bar-container', { 'loading-bar-container--active': isGenerating }]"
    :role="isGenerating ? 'status' : undefined"
    :aria-live="isGenerating ? 'polite' : undefined"
    :aria-label="isGenerating ? 'AI 正在处理' : undefined"
  >
    <div v-if="isGenerating" class="loading-bar-sweep" />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  isGenerating: boolean
}>()
</script>

<style scoped>
.loading-bar-container {
  width: 100%;
  height: 0;
  overflow: hidden;
  transition: height 0.2s ease;
}

.loading-bar-container--active {
  height: 3px;
}

.loading-bar-sweep {
  height: 100%;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: sweep 1.5s ease-in-out infinite;
}

@keyframes sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}

@media (prefers-reduced-motion: reduce) {
  .loading-bar-sweep {
    animation: none;
    width: 100%;
    opacity: 0.4;
  }
}
</style>
