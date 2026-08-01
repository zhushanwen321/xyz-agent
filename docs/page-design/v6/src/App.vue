<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ShellView from './views/ShellView.vue'
import SettingsOverlay from './components/settings/SettingsOverlay.vue'
import SearchModal from './components/overlays/SearchModal.vue'
import { searchModalOpen, settingsOpen, handleEscape, openSearch } from './composables/useStore'

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') handleEscape()
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openSearch()
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="app-root">
    <ShellView />
    <SearchModal v-if="searchModalOpen" />
    <SettingsOverlay v-if="settingsOpen" />
  </div>
</template>

<style scoped>
.app-root {
  width: 100%;
  height: 100%;
  position: relative;
}
</style>
