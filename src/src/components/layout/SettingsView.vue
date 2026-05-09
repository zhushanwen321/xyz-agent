<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { ProviderPane, SkillsPane, AgentsPane } from '../settings'

const settingsStore = useSettingsStore()
const activeTab = ref('providers')

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // 如果有 modal 打开，让 modal 自己处理 Escape，不关闭设置页面
    if (document.querySelector('.s-modal-overlay.visible')) return
    e.preventDefault()
    e.stopPropagation()
    settingsStore.setView('chat')
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    settingsStore.setView('chat')
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="settings-view active">
    <!-- Sidebar -->
    <div class="settings-sidebar">
      <div class="settings-sidebar__hd">设置</div>
      <div class="settings-sidebar__list">
        <div
          class="settings-tab"
          :class="{ active: activeTab === 'providers' }"
          @click="activeTab = 'providers'"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 8h4M5 10h5"/></svg>
          供应商
        </div>
        <div
          class="settings-tab"
          :class="{ active: activeTab === 'skills' }"
          @click="activeTab = 'skills'"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z"/></svg>
          SKILL
        </div>
        <div
          class="settings-tab"
          :class="{ active: activeTab === 'agents' }"
          @click="activeTab = 'agents'"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
          AGENT
        </div>

      </div>
    </div>

    <!-- Content -->
    <div class="settings-content">
      <div class="settings-content__pane" :class="{ active: activeTab === 'providers' }">
        <ProviderPane />
      </div>
      <div class="settings-content__pane" :class="{ active: activeTab === 'skills' }">
        <SkillsPane />
      </div>
      <div class="settings-content__pane" :class="{ active: activeTab === 'agents' }">
        <AgentsPane />
      </div>

    </div>
  </div>
</template>

<style scoped>
/* All styles come from the global design system */
</style>
