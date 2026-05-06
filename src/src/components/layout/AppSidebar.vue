<script setup lang="ts">
import { ref } from 'vue'
import { useSessionStore } from '../../stores/session'
import { Input, Button, Dialog } from '../../design-system'
import { SessionSearch, SessionGroup } from '../sidebar'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const sessionStore = useSessionStore()

defineEmits<{ create: [] }>()

const searchQuery = ref('')
const collapsed = ref(false)
const deleteTarget = ref<string | null>(null)
const renameTarget = ref<string | null>(null)
const renameValue = ref('')

function toggleCollapse() {
  collapsed.value = !collapsed.value
}

function confirmDelete() {
  if (deleteTarget.value) {
    sessionStore.removeSession(deleteTarget.value)
    deleteTarget.value = null
  }
}

function startRename(id: string) {
  const session = sessionStore.sessions.find(s => s.id === id)
  if (!session) return
  renameTarget.value = id
  renameValue.value = session.label
}

function confirmRename() {
  if (renameTarget.value && renameValue.value.trim()) {
    const session = sessionStore.sessions.find(s => s.id === renameTarget.value)
    if (session) {
      session.label = renameValue.value.trim()
    }
    renameTarget.value = null
    renameValue.value = ''
  }
}

function cancelRename() {
  renameTarget.value = null
  renameValue.value = ''
}
</script>

<template>
  <aside :class="['sidebar', { collapsed }]">
    <div class="sidebar-hd">
      <span v-if="!collapsed" class="sidebar-title">{{ t('sidebar.sessions') }}</span>
      <button class="sidebar-add" @click="$emit('create')">+</button>
      <button class="sidebar-toggle" @click="toggleCollapse" :aria-label="collapsed ? t('sidebar.expand') : t('sidebar.collapse')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <polyline v-if="collapsed" points="10,3 5,8 10,13" />
          <polyline v-else points="6,3 11,8 6,13" />
        </svg>
      </button>
    </div>

    <template v-if="!collapsed">
      <SessionSearch v-model="searchQuery" />

      <div class="sidebar-list">
        <SessionGroup
          :groups="sessionStore.groupedSessions"
          :current-session-id="sessionStore.currentSessionId"
          :search-query="searchQuery"
          @switch-session="sessionStore.switchSession($event)"
          @rename-session="startRename($event)"
          @delete-session="deleteTarget = $event"
        />
        <div v-if="sessionStore.sessions.length === 0" class="no-sessions">
          {{ t('sidebar.noSessions') }}
        </div>
      </div>
    </template>
  </aside>

  <!-- Delete confirmation -->
  <Dialog :open="!!deleteTarget" :title="t('sidebar.deleteConfirmTitle')" @update:open="deleteTarget = null">
    <p class="dialog-text">{{ t('sidebar.deleteConfirmMessage') }}</p>
    <div class="dialog-actions">
      <Button variant="ghost" size="sm" @click="deleteTarget = null">{{ t('common.cancel') }}</Button>
      <Button variant="danger" size="sm" @click="confirmDelete">{{ t('common.delete') }}</Button>
    </div>
  </Dialog>

  <!-- Rename prompt (P1 simplified: inline dialog) -->
  <Dialog :open="!!renameTarget" :title="t('sidebar.renameSession')" @update:open="cancelRename">
    <Input v-model="renameValue" :placeholder="t('sidebar.renamePrompt')" @keydown.enter="confirmRename" />
    <div class="dialog-actions">
      <Button variant="ghost" size="sm" @click="cancelRename">{{ t('common.cancel') }}</Button>
      <Button variant="primary" size="sm" @click="confirmRename">{{ t('common.save') }}</Button>
    </div>
  </Dialog>
</template>


<style scoped>
.sidebar {
  width: var(--sidebar-width);
  display: flex; flex-direction: column;
  background: var(--color-surface);
  border-right: 1px solid var(--color-border);
  flex-shrink: 0;
  transition: width 0.2s ease;
}
.sidebar.collapsed { width: 48px; }
.sidebar-hd {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--color-border);
}
.sidebar.collapsed .sidebar-hd { justify-content: center; gap: 0; }
.sidebar-title {
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; color: var(--color-text-muted);
}
.sidebar-add {
  width: 22px; height: 22px; border-radius: var(--radius-sm);
  border: 1px solid var(--color-border); background: transparent;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--color-text-muted); font-size: 14px;
}
.sidebar-add:hover { background: var(--color-accent-light); color: var(--color-accent); }
.sidebar-toggle {
  width: 22px; height: 22px; border-radius: var(--radius-sm);
  border: none; background: transparent; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--color-text-muted);
}
.sidebar-toggle:hover { background: var(--color-accent-light); color: var(--color-accent); }
.sidebar-toggle svg { width: 14px; height: 14px; }
.sidebar-list { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.no-sessions {
  padding: 20px 14px; text-align: center;
  color: var(--color-text-muted); font-size: 12px;
}
.dialog-text {
  font-size: 14px; color: var(--color-text-primary);
  margin-bottom: 16px; line-height: 1.5;
}
.dialog-actions {
  display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;
}
</style>
