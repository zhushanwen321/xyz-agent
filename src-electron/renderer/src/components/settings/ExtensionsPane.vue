<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { on, off } from '../../lib/event-bus'
import { send } from '../../lib/ws-client'
import type { ServerMessage, ExtensionInfo } from '@xyz-agent/shared'
import ExtensionSection from './ExtensionSection.vue'

const { t } = useI18n()

const extensions = ref<ExtensionInfo[]>([])

function onExtensions(msg: ServerMessage) {
  const payload = msg.payload as { extensions?: ExtensionInfo[] }
  if (payload.extensions) {
    extensions.value = payload.extensions
  }
}

function handleToggle(payload: { name: string; enabled: boolean }) {
  const { name, enabled } = payload
  // 立即更新 UI 状态，避免等待 server 回传的延迟
  const target = extensions.value.find(ext => ext.name === name)
  if (target) target.enabled = enabled
  send({ type: 'extension.toggle', payload: { name, enabled } })
}

onMounted(() => {
  on('config.extensions', onExtensions)
  send({ type: 'extension.list', payload: {} })
})

onUnmounted(() => {
  off('config.extensions', onExtensions)
})
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="mb-7">
      <div class="font-display text-[22px] font-bold tracking-tight">{{ t('settings.extensionConfig') }}</div>
      <div class="text-[12px] text-muted mt-1">{{ t('settings.extensionConfigDesc') }}</div>
    </div>

    <!-- Extension list -->
    <div v-if="extensions.length > 0" class="border border-border rounded-sm overflow-hidden mb-3">
      <div class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
        <span class="text-[13px] font-semibold">{{ t('settings.installedExtensions') }}</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">{{ extensions.length }}</span>
      </div>
      <div>
        <ExtensionSection
          v-for="ext in extensions"
          :key="ext.name"
          :extension="ext"
          @toggle-enabled="handleToggle"
        />
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-else
      class="border border-border rounded-sm py-12 px-6 text-center"
    >
      <svg class="mx-auto mb-3 text-muted" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M9 12h6M12 9v6" />
      </svg>
      <div class="text-[13px] text-muted">{{ t('settings.noExtensions') }}</div>
    </div>
  </div>
</template>
