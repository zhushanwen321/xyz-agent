<script setup lang="ts">
import { ref, computed } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useSessionStore } from '../../stores/session'
import { Input, Button, Dialog } from '../../design-system'
import { SessionItem } from '../sidebar'
import { useI18n } from 'vue-i18n'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'

const { t } = useI18n()
const sessionStore = useSessionStore()

defineEmits<{ create: [] }>()

const searchQuery = ref('')
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
  <aside class="sidebar">
    <div class="sidebar__hd">
      <span class="sidebar__hd-title">{{ t('sidebar.sessions') }}</span>
      <button class="sidebar__hd-btn" @click="$emit('create')">+</button>
    </div>

    <template>
      <!-- TODO: search disabled per design -->
      <!-- <SessionSearch v-model="searchQuery" /> -->

      <div ref="scrollRef" class="sidebar__body">
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
              <div
                v-if="getVirtualRow(virtualItem.index).type === 'group'"
                :class="['s-group__hd', { collapsed: groupCollapsed.has(asGroup(getVirtualRow(virtualItem.index)).cwd) }]"
                @click="toggleGroup(asGroup(getVirtualRow(virtualItem.index)).cwd)"
              >
                <span class="s-group__toggle">&#9662;</span>
                {{ dirname(asGroup(getVirtualRow(virtualItem.index)).cwd) }}
              </div>
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
  width: var(--sidebar-w);
  z-index: 55;
  display: flex; flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
  flex-shrink: 0;
}
/* sidebar__hd, sidebar__hd-title, sidebar__hd-btn are defined in global CSS */
.sidebar__hd-btn svg { width: 14px; height: 14px; }
/* 分组头部与 css_design-system.css 的 .s-group__hd 对齐 */
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
.s-group__hd.collapsed .s-group__toggle { transform: rotate(-90deg); }
.no-sessions {
  padding: 20px 14px; text-align: center;
  color: var(--muted); font-size: 12px;
}
.dialog-text {
  font-size: 14px; color: var(--fg);
  margin-bottom: 16px; line-height: 1.5;
}
.dialog-actions {
  display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;
}
</style>
