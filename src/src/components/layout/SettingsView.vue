<template>
  <div class="settings-view">
    <h2>{{ t('settings.title') }}</h2>
    <button @click="settingsStore.setView('chat')">{{ t('common.back') }}</button>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const settingsStore = useSettingsStore()
</script>
