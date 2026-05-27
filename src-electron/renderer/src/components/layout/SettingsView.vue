<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { ProviderPane, SkillsPane, AgentsPane, ExtensionsPane, SystemPane } from '../settings'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const activeTab = ref('providers')

const tabs = [
  { key: 'providers', labelKey: 'settings.tabProviders', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 8h4M5 10h5"/></svg>' },
  { key: 'skills', labelKey: 'settings.tabSkills', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z"/></svg>' },
  { key: 'agents', labelKey: 'settings.tabAgents', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>' },
  { key: 'system', labelKey: 'settings.tabSystem', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>' },
  { key: 'extensions', labelKey: 'settings.tabExtensions', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><path d="M11 9v4M9 11h4"/></svg>' },
] as const

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // 如果有 modal 打开，让 modal 自己处理 Escape，不关闭设置页面
    if (document.querySelector('[data-modal-visible]')) return
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
  <div class="flex flex-1 overflow-hidden bg-bg">
    <!-- Sidebar -->
    <div class="w-[200px] bg-surface border-r border-border flex flex-col shrink-0">
      <div class="py-3.5 px-4 font-display text-[15px] font-semibold border-b border-border">{{ t('settings.title') }}</div>
      <div class="flex-1 overflow-y-auto py-1.5">
        <div
          v-for="tab in tabs"
          :key="tab.key"
          :class="[
            'flex items-center gap-2 py-[9px] px-4 text-[13px] text-muted cursor-pointer transition-all duration-150 border-l-[3px] select-none [&_svg]:w-3.5 [&_svg]:h-3.5 hover:bg-accent-light hover:text-fg rounded-sm',
            activeTab === tab.key ? 'text-accent border-l-accent font-semibold bg-accent-light' : 'border-l-transparent'
          ]"
          @click="activeTab = tab.key"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-html="tab.icon" />
          {{ t(tab.labelKey) }}
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto py-6 px-8">
      <div v-show="activeTab === 'providers'">
        <ProviderPane />
      </div>
      <div v-show="activeTab === 'skills'">
        <SkillsPane />
      </div>
      <div v-show="activeTab === 'agents'">
        <AgentsPane />
      </div>
      <div v-show="activeTab === 'system'">
        <SystemPane />
      </div>
      <div v-show="activeTab === 'extensions'">
        <ExtensionsPane />
      </div>
    </div>
  </div>
</template>

