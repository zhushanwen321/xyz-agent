<script setup lang="ts">
/**
 * SettingsTab —— Settings tab content 包装（spec P4 §3.1 + slice C2 + w2-C3）。
 *
 * 薄包装：直接渲染 MobileSettings（settings 不依赖 session）。
 * 与 FilesTab/SessionsTab 对称（解耦 MobileShell，让 shell 保持薄）。
 */
import MobileSettings from './MobileSettings.vue'
</script>

<template>
  <div class="settings-tab h-full" data-testid="mobile-settings-tab">
    <MobileSettings />
  </div>
</template>
