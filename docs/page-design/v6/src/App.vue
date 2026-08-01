<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ShellView from './views/ShellView.vue'
import SettingsOverlay from './components/settings/SettingsOverlay.vue'
import SearchModal from './components/overlays/SearchModal.vue'
import AskUserOverlay from './components/overlays/AskUserOverlay.vue'
import ConfirmDialog from './components/overlays/ConfirmDialog.vue'
import {
  searchModalOpen,
  settingsOpen,
  askUserOpen,
  confirmOpen,
  handleEscape,
  openSearch,
  closeAskUser,
  closeConfirm,
  sidebarCollapsed,
} from './composables/useStore'

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') handleEscape()
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openSearch()
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
    e.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
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
    <!-- §4.6 AskUserOverlay · companion 场景（composer 上方 companion-band），demo 全局浮起 -->
    <div v-if="askUserOpen" class="au-band">
      <AskUserOverlay @confirm="closeAskUser" @cancel="closeAskUser" />
    </div>
    <!-- §4.6 ConfirmDialog · 确认场景 -->
    <ConfirmDialog
      v-if="confirmOpen"
      variant="danger"
      title="确认删除"
      desc="此操作不可撤销"
      confirm-text="删除"
      cancel-text="取消"
      @confirm="closeConfirm"
      @cancel="closeConfirm"
    />
  </div>
</template>

<style scoped>
.app-root {
  width: 100%;
  height: 100%;
  position: relative;
}
/* companion-band：固定在 composer 上方区域，demo 简化为右下浮起 */
.au-band {
  position: fixed;
  right: 24px;
  bottom: 120px;
  width: 360px;
  max-width: calc(100vw - 48px);
  z-index: var(--z-overlay);
}
</style>
