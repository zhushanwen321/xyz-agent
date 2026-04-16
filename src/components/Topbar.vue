<script setup lang="ts">
import { ref } from 'vue'
import { isTauri, getCurrentModel, setCurrentModel as apiSetCurrentModel } from '../lib/tauri'
import { Button } from '@/components/ui/button'
import ModelSelector from './ModelSelector.vue'

const props = defineProps<{
  sidebarCollapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'navigate', page: 'chat' | 'settings'): void
}>()

const currentPage = ref<'chat' | 'settings'>('chat')
const currentModel = ref('loading...')

if (isTauri()) {
  getCurrentModel().then((m) => { currentModel.value = m }).catch(() => {})
}

async function onModelSelect(modelRef: string) {
  currentModel.value = modelRef
  if (isTauri()) {
    try {
      await apiSetCurrentModel(modelRef)
    } catch {
      // API 失败时回退
      currentModel.value = await getCurrentModel()
    }
  }
}

function navigate(page: 'chat' | 'settings') {
  currentPage.value = page
  emit('navigate', page)
}
</script>

<template>
  <div class="flex h-10 shrink-0 items-center border-b border-border-default bg-elevated px-4">
    <!-- 左: logo -->
    <span class="font-mono text-sm font-semibold text-semantic-green">xyz-agent</span>

    <!-- 中: 导航 -->
    <div class="ml-6 flex gap-1">
      <Button
        variant="ghost"
        class="rounded px-3 py-1 font-mono text-xs transition-colors"
        :class="currentPage === 'chat'
          ? 'bg-semantic-green/10 text-semantic-green'
          : 'text-tertiary hover:text-foreground'"
        @click="navigate('chat')"
      >
        Chat
      </Button>
      <Button
        variant="ghost"
        class="rounded px-3 py-1 font-mono text-xs transition-colors"
        :class="currentPage === 'settings'
          ? 'bg-semantic-green/10 text-semantic-green'
          : 'text-tertiary hover:text-foreground'"
        @click="navigate('settings')"
      >
        Settings
      </Button>
    </div>

    <!-- 右: 模型名 + 折叠按钮 -->
    <div class="ml-auto flex items-center gap-3">
      <ModelSelector :current-model="currentModel" @select="onModelSelect" />
      <Button
        variant="ghost"
        size="icon"
        class="text-tertiary transition-colors hover:text-foreground"
        @click="$emit('toggle-sidebar')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18" />
        </svg>
      </Button>
    </div>
  </div>
</template>
