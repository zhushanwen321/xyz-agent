<template>
  <div class="chat-panel">
    <div class="panel-bar">
      <span>Chat</span>
    </div>
    <div class="chat-msgs">
      <p class="text-muted p-4">{{ t('chat.inputPlaceholder') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
</script>

<style scoped>
.chat-panel { flex: 1; display: flex; flex-direction: column; }
.panel-bar { padding: 8px 16px; border-bottom: 1px solid var(--color-border); }
.chat-msgs { flex: 1; overflow-y: auto; padding: 20px 24px; }
</style>
