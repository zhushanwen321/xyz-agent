<template>
  <aside class="sidebar">
    <div class="sidebar-hd">
      <span class="sidebar-title">{{ t('sidebar.sessions') }}</span>
      <button class="sidebar-add" @click="$emit('create')">+</button>
    </div>
    <div class="sidebar-search">
      <Input :placeholder="t('sidebar.searchPlaceholder')" />
    </div>
    <div class="sidebar-list">
      <div v-for="group in sessionStore.groupedSessions" :key="group.cwd" class="session-group">
        <div class="group-label">{{ group.cwd }}</div>
        <div
          v-for="s in group.sessions" :key="s.id"
          :class="['session-item', { active: s.id === sessionStore.currentSessionId }]"
          @click="sessionStore.switchSession(s.id)"
        >
          <span class="session-dot" :style="{ background: s.status === 'active' ? 'var(--color-success)' : 'var(--color-border)' }"></span>
          <span class="session-label">{{ s.label }}</span>
        </div>
      </div>
      <div v-if="sessionStore.sessions.length === 0" class="no-sessions">{{ t('sidebar.noSessions') }}</div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useSessionStore } from '../../stores/session'
import { Input } from '../../design-system'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const sessionStore = useSessionStore()
defineEmits<{ create: [] }>()
</script>

<style scoped>
.sidebar { width: var(--sidebar-width); display: flex; flex-direction: column; background: var(--color-surface); border-right: 1px solid var(--color-border); flex-shrink: 0; }
.sidebar-hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--color-border); }
.sidebar-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--color-text-muted); }
.sidebar-add { width: 22px; height: 22px; border-radius: var(--radius-sm); border: 1px solid var(--color-border); background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--color-text-muted); }
.sidebar-add:hover { background: var(--color-accent-light); color: var(--color-accent); }
.sidebar-search { padding: 8px 14px; }
.sidebar-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.session-group { margin-bottom: 4px; }
.group-label { padding: 6px 14px; font-size: 11px; font-weight: 600; color: var(--color-text-muted); }
.session-item { display: flex; align-items: center; gap: 8px; padding: 7px 14px; cursor: pointer; border-left: 3px solid transparent; }
.session-item:hover { background: var(--color-accent-light); }
.session-item.active { background: var(--color-accent-light); border-left-color: var(--color-accent); }
.session-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.session-label { flex: 1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.no-sessions { padding: 20px 14px; text-align: center; color: var(--color-text-muted); font-size: 12px; }
</style>
