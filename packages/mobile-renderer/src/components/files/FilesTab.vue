<script setup lang="ts">
/**
 * FilesTab —— Files tab content 包装（spec P4 §3.1 + slice C1 + w1-C2）。
 *
 * 薄包装：有 sessionId 时渲染 MobileFilesView（只读文件树），无 sessionId 时显示提示。
 * MobileShell 持有 currentSessionId（从 SessionsTab 选中态透传），传入本组件。
 * 与 SessionsTab 对称（解耦 MobileShell，让 shell 保持薄）。
 */
import { useI18n } from 'vue-i18n'
import MobileFilesView from './MobileFilesView.vue'

defineProps<{ sessionId: string | null }>()
defineEmits<{ select: [path: string] }>()

const { t } = useI18n()
</script>

<template>
  <div class="files-tab h-full" data-testid="mobile-files-tab">
    <!-- 无 session：提示用户先选择会话 -->
    <div
      v-if="!sessionId"
      class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="mobile-files-select-session"
    >
      <span class="text-sm text-muted">{{ t('mobile.files.selectSession') }}</span>
    </div>
    <!-- 有 session：渲染只读文件树 -->
    <MobileFilesView
      v-else
      :session-id="sessionId"
      @select="$emit('select', $event)"
    />
  </div>
</template>
