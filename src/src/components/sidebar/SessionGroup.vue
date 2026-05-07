<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SessionGroup } from '@xyz-agent/shared'
import { ScrollArea } from '../../design-system'
import SessionItem from './SessionItem.vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  groups: SessionGroup[]
  currentSessionId: string | null
  searchQuery: string
}>()

const emit = defineEmits<{
  switchSession: [id: string]
  renameSession: [id: string]
  deleteSession: [id: string]
}>()

const { t } = useI18n()

const collapsed = ref<Set<string>>(new Set())

const filteredGroups = computed(() => {
  const q = props.searchQuery.trim().toLowerCase()
  if (!q) return props.groups
  return props.groups
    .map(g => ({
      cwd: g.cwd,
      sessions: g.sessions.filter(s => s.label.toLowerCase().includes(q)),
    }))
    .filter(g => g.sessions.length > 0)
})

const hasResults = computed(() => filteredGroups.value.length > 0)

function toggleGroup(cwd: string) {
  const next = new Set(collapsed.value)
  if (next.has(cwd)) next.delete(cwd)
  else next.add(cwd)
  collapsed.value = next
}

function dirname(cwd: string): string {
  const parts = cwd.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || cwd
}
</script>

<template>
  <ScrollArea class="session-groups">
    <template v-if="hasResults">
      <div v-for="group in filteredGroups" :key="group.cwd" class="group">
        <button class="group-header" @click="toggleGroup(group.cwd)">
          <svg
            :class="['chevron', { collapsed: collapsed.has(group.cwd) }]"
            viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
          >
            <polyline points="6,4 10,8 6,12" />
          </svg>
          <svg class="folder-icon" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.707L6.44 2.73A1.5 1.5 0 0 0 5.378 2.3H1.5z" />
          </svg>
          <span class="group-name">{{ dirname(group.cwd) }}</span>
          <span class="group-count">{{ group.sessions.length }}</span>
        </button>
        <div v-show="!collapsed.has(group.cwd)" class="group-sessions">
          <SessionItem
            v-for="s in group.sessions"
            :key="s.id"
            :session="s"
            :is-active="s.id === currentSessionId"
            @click="emit('switchSession', s.id)"
            @rename="emit('renameSession', $event)"
            @delete="emit('deleteSession', $event)"
          />
        </div>
      </div>
    </template>
    <div v-else class="empty-state">
      {{ t('sidebar.noSearchResults') }}
    </div>
  </ScrollArea>
</template>

<style scoped>
.session-groups { flex: 1; }
.group { margin-bottom: 2px; }
.group-header {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 6px 14px;
  background: none; border: none; cursor: pointer;
  color: var(--muted); font-size: 11px; font-weight: 600;
  text-align: left;
}
.group-header:hover { color: var(--fg); }
.chevron {
  width: 12px; height: 12px; flex-shrink: 0;
  transition: transform 0.15s;
}
.chevron.collapsed { transform: rotate(0deg); }
.chevron:not(.collapsed) { transform: rotate(90deg); }
.folder-icon { width: 13px; height: 13px; flex-shrink: 0; opacity: 0.6; }
.group-name {
  flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.group-count {
  font-size: 10px; font-weight: 500;
  background: var(--border); color: var(--muted);
  border-radius: var(--radius-sm); padding: 1px 5px;
}
.group-sessions { /* no extra styles needed */ }
.empty-state {
  padding: 24px 14px; text-align: center;
  color: var(--muted); font-size: 12px;
}
</style>
