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
        <div class="s-group__hd" @click="toggleGroup(group.cwd)">
          <span class="s-group__toggle">&#9662;</span>
          {{ dirname(group.cwd) }}
        </div>
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
/* 与 css_design-system.css 的 .s-group__hd 对齐 */
.s-group__hd {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 14px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--muted); cursor: pointer; user-select: none;
}
.s-group__hd:hover { color: var(--fg); }
.s-group__toggle {
  font-size: 8px; transition: transform 0.2s var(--ease);
  display: inline-block; width: 10px; text-align: center;
}
.group-sessions { /* no extra styles needed */ }
.empty-state {
  padding: 24px 14px; text-align: center;
  color: var(--muted); font-size: 12px;
}
</style>
