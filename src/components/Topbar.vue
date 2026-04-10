<script setup lang="ts">
import { ref } from 'vue'
import { isTauri } from '../lib/tauri'

const props = defineProps<{
  sidebarCollapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'navigate', page: 'chat' | 'settings'): void
}>()

const currentPage = ref<'chat' | 'settings'>('chat')
const modelName = ref('loading...')

// 在 Tauri 环境中异步获取当前模型名称
if (isTauri()) {
  import('../lib/tauri').then(({ getCurrentModel }) => {
    getCurrentModel().then((m) => { modelName.value = m })
  })
}

function navigate(page: 'chat' | 'settings') {
  currentPage.value = page
  emit('navigate', page)
}
</script>

<template>
  <div class="flex h-10 shrink-0 items-center border-b border-border-default bg-bg-elevated px-4">
    <!-- 左: logo -->
    <span class="font-mono text-sm font-semibold text-accent">xyz-agent</span>

    <!-- 中: 导航 -->
    <div class="ml-6 flex gap-1">
      <button
        class="rounded px-3 py-1 font-mono text-xs transition-colors"
        :class="currentPage === 'chat'
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-primary'"
        @click="navigate('chat')"
      >
        Chat
      </button>
      <button
        class="rounded px-3 py-1 font-mono text-xs transition-colors"
        :class="currentPage === 'settings'
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-primary'"
        @click="navigate('settings')"
      >
        Settings
      </button>
    </div>

    <!-- 右: 模型名 + 折叠按钮 -->
    <div class="ml-auto flex items-center gap-3">
      <span class="font-mono text-[11px] text-text-tertiary">{{ modelName }}</span>
      <button
        class="text-text-tertiary transition-colors hover:text-text-primary"
        @click="$emit('toggle-sidebar')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18" />
        </svg>
      </button>
    </div>
  </div>
</template>
