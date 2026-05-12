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
  <ScrollArea class="flex-1">
    <template v-if="hasResults">
      <div v-for="group in filteredGroups" :key="group.cwd" class="mb-[2px]">
        <div class="flex items-center gap-[5px] py-[6px] px-[14px] text-[11px] font-semibold uppercase tracking-[0.04em] text-muted cursor-pointer select-none hover:text-fg" @click="toggleGroup(group.cwd)">
          <span class="text-[8px] inline-block w-[10px] text-center transition-transform duration-200 ease-ease">&#9662;</span>
          {{ dirname(group.cwd) }}
        </div>
        <div v-show="!collapsed.has(group.cwd)">
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
    <div v-else class="py-6 px-[14px] text-center text-muted text-xs">
      {{ t('sidebar.noSearchResults') }}
    </div>
  </ScrollArea>
</template>

