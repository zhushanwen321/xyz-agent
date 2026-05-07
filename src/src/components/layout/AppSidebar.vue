<script setup lang="ts">
import { ref, computed } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useSessionStore } from '../../stores/session'
import { Input, Button, Dialog } from '../../design-system'
import { SessionSearch, SessionItem } from '../sidebar'
import { useI18n } from 'vue-i18n'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'

const { t } = useI18n()
const sessionStore = useSessionStore()

defineEmits<{ create: [] }>()

const searchQuery = ref('')
const collapsed = ref(false)
const deleteTarget = ref<string | null>(null)
const renameTarget = ref<string | null>(null)
const renameValue = ref('')
const groupCollapsed = ref<Set<string>>(new Set())

// Flatten groups into a virtualizable list, respecting search + collapse state
type VirtualItem =
  | { type: 'group'; cwd: string; sessionCount: number }
  | { type: 'session'; session: SessionSummary }

const filteredGroups = computed<SessionGroup[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return sessionStore.groupedSessions
  return sessionStore.groupedSessions
    .map(g => ({
      cwd: g.cwd,
      sessions: g.sessions.filter(s => s.label.toLowerCase().includes(q)),
    }))
    .filter(g => g.sessions.length > 0)
})

const allSessionItems = computed<VirtualItem[]>(() => {
  const items: VirtualItem[] = []
  for (const group of filteredGroups.value) {
    items.push({ type: 'group', cwd: group.cwd, sessionCount: group.sessions.length })
    if (!groupCollapsed.value.has(group.cwd)) {
      for (const session of group.sessions) {
        items.push({ type: 'session', session })
      }
    }
  }
  return items
})

const scrollRef = ref<HTMLElement | null>(null)

const virtualizer = useVirtualizer(
  computed(() => ({
    count: allSessionItems.value.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: (index: number) => {
      const GROUP_HEADER_HEIGHT = 32
      const SESSION_ITEM_HEIGHT = 48
      const item = allSessionItems.value[index]
      return item?.type === 'group' ? GROUP_HEADER_HEIGHT : SESSION_ITEM_HEIGHT
    },
    overscan: 5,
  }))
)

function toggleGroup(cwd: string) {
  const next = new Set(groupCollapsed.value)
  if (next.has(cwd)) next.delete(cwd)
  else next.add(cwd)
  groupCollapsed.value = next
}

function dirname(cwd: string): string {
  const parts = cwd.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

function getVirtualRow(index: number) {
  return allSessionItems.value[index]!
}

function asGroup(item: VirtualItem) {
  return item as { type: 'group'; cwd: string; sessionCount: number }
}

function asSession(item: VirtualItem) {
  return item as { type: 'session'; session: SessionSummary }
}

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

      <div ref="scrollRef" class="sidebar-list">
        <template v-if="sessionStore.sessions.length > 0">
          <div :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }">
            <div
              v-for="virtualItem in virtualizer.getVirtualItems()"
              :key="String(virtualItem.key)"
              :style="{
                position: 'absolute',
                top: 0,
                transform: `translateY(${virtualItem.start}px)`,
                width: '100%',
              }"
            >
              <!-- Group header -->
              <button
                v-if="getVirtualRow(virtualItem.index).type === 'group'"
                class="group-header"
                @click="toggleGroup(asGroup(getVirtualRow(virtualItem.index)).cwd)"
              >
                <svg
                  :class="['chevron', { collapsed: groupCollapsed.has(asGroup(getVirtualRow(virtualItem.index)).cwd) }]"
                  viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
                >
                  <polyline points="6,4 10,8 6,12" />
                </svg>
                <svg class="folder-icon" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.707L6.44 2.73A1.5 1.5 0 0 0 5.378 2.3H1.5z" />
                </svg>
                <span class="group-name">{{ dirname(asGroup(getVirtualRow(virtualItem.index)).cwd) }}</span>
                <span class="group-count">{{ asGroup(getVirtualRow(virtualItem.index)).sessionCount }}</span>
              </button>
              <!-- Session item -->
              <SessionItem
                v-else
                :session="asSession(getVirtualRow(virtualItem.index)).session"
                :is-active="asSession(getVirtualRow(virtualItem.index)).session.id === sessionStore.currentSessionId"
                @click="sessionStore.switchSession(asSession(getVirtualRow(virtualItem.index)).session.id)"
                @rename="startRename($event)"
                @delete="deleteTarget = $event"
              />
            </div>
          </div>
        </template>
        <div v-else class="no-sessions">
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
.sidebar-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
.group-header {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 6px 14px;
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted); font-size: 11px; font-weight: 600;
  text-align: left;
}
.group-header:hover { color: var(--color-text-primary); }
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
  background: var(--color-border); color: var(--color-text-muted);
  border-radius: var(--radius-sm); padding: 1px 5px;
}
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
