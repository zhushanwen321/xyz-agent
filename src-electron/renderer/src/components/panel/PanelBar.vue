<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import { usePanelStore } from '../../stores/panel'
import { useSessionStore } from '../../stores/session'
import { useWindowStore } from '../../stores/window'
import AnchorDropdown from './AnchorDropdown.vue'

interface AgentOption {
  id: string
  label: string
  color?: string
}

const props = withDefaults(
  defineProps<{
    agentOptions: AgentOption[]
    activeAgentId: string
    panelId?: string
    sessionId?: string | null
    doneCount?: number
    alertCount?: number
  }>(),
  {
    panelId: '',
  }
)

defineEmits<{
  'switch-agent': [id: string]
  'open-drawer': [type: string]
  'close-pane': []
}>()

const panelStore = usePanelStore()
const windowStore = useWindowStore()
const sessionStore = useSessionStore()

const sessionInfo = computed(() => {
  if (!props.sessionId) return null
  return sessionStore.sessions.find(s => s.id === props.sessionId) ?? null
})

const dirName = computed(() => {
  const cwd = sessionInfo.value?.cwd
  if (!cwd) return ''
  return cwd.split('/').pop() ?? cwd
})

const showCloseButton = computed(() => panelStore.panelCount > 1)

// ── 右键上下文菜单 ────────────────────────────────────────────────
const contextMenuVisible = ref(false)
const contextMenuPos = ref({ x: 0, y: 0 })

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  contextMenuPos.value = { x: e.clientX, y: e.clientY }
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
}

async function moveToNewWindow() {
  closeContextMenu()
  if (!props.sessionId || !props.panelId) return
  try {
    await windowStore.createWindow(props.sessionId)
    panelStore.unbindSession(props.panelId)
  // eslint-disable-next-line taste/no-silent-catch -- intentional: window creation failure should not break the UI
  } catch (e) {
    console.error('Failed to move pane to new window:', e)
  }
}

function splitPanel(direction: 'horizontal' | 'vertical') {
  closeContextMenu()
  if (!props.panelId) return
  panelStore.splitPanel(props.panelId, direction)
}
</script>

<template>
  <div class="flex items-center gap-2 px-3 h-9 bg-surface border-b border-border shrink-0 text-xs" @contextmenu.prevent="onContextMenu">
    <AnchorDropdown
      :options="agentOptions"
      :current-id="activeAgentId"
      @select="$emit('switch-agent', $event)"
    />

    <!-- Session 标识：目录名 / session label -->
    <span v-if="sessionInfo" class="inline-flex items-center gap-1 text-[11px] text-muted overflow-hidden whitespace-nowrap min-w-0" :title="sessionInfo.cwd">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <path d="M2 4a1 1 0 011-1h3.586a1 1 0 01.707.293l1.414 1.414a1 1 0 00.707.293H13a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/>
      </svg>
      <span class="text-fg font-medium truncate">{{ dirName }}</span>
      <span v-if="sessionInfo.label && sessionInfo.label !== dirName" class="text-border">/</span>
      <span v-if="sessionInfo.label && sessionInfo.label !== dirName" class="text-muted truncate">{{ sessionInfo.label }}</span>
    </span>
    <span v-else class="inline-flex items-center gap-1 text-[11px] text-muted overflow-hidden whitespace-nowrap min-w-0 italic opacity-50">空面板</span>

    <div v-if="(doneCount ?? 0) > 0 || (alertCount ?? 0) > 0" class="flex items-center gap-[5px]">
      <span v-if="(doneCount ?? 0) > 0" class="inline-flex items-center gap-1 px-2 py-[2px] rounded-full cursor-pointer text-[11px] font-semibold transition-all duration-150 ease-ease border border-transparent bg-success-light text-success hover:border-success focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2" role="button" tabindex="0" @click="$emit('open-drawer', 'done')" @keydown.enter="$emit('open-drawer', 'done')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px"><polyline points="2 6 5 9 10 3"/></svg>
        <span class="inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full text-[9px] font-bold text-white bg-success">{{ doneCount }}</span>
      </span>
      <span v-if="(alertCount ?? 0) > 0" class="inline-flex items-center gap-1 px-2 py-[2px] rounded-full cursor-pointer text-[11px] font-semibold transition-all duration-150 ease-ease border border-transparent bg-danger-light text-danger hover:border-danger focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2" role="button" tabindex="0" @click="$emit('open-drawer', 'alert')" @keydown.enter="$emit('open-drawer', 'alert')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:10px;height:10px"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8v.5"/></svg>
        <span class="inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full text-[9px] font-bold text-white bg-danger animate-pulse-dot">{{ alertCount }}</span>
      </span>
    </div>

    <Button
      v-if="showCloseButton"
      variant="ghost"
      size="icon"
      class="ml-auto shrink-0"
      aria-label="关闭面板"
      @click="$emit('close-pane')"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <line x1="3" y1="3" x2="9" y2="9" />
        <line x1="9" y1="3" x2="3" y2="9" />
      </svg>
    </Button>

    <!-- 右键上下文菜单 -->
    <Teleport to="body">
      <div v-if="contextMenuVisible" class="fixed inset-0 z-[1000]" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu" />
      <div
        v-if="contextMenuVisible"
        class="fixed z-[1001] min-w-[160px] p-1 bg-surface border border-border rounded-sm shadow-md text-xs leading-snug text-fg"
        :style="{ top: contextMenuPos.y + 'px', left: contextMenuPos.x + 'px' }"
        @click.stop
      >
        <div
          v-if="sessionId"
          class="flex items-center gap-2 px-2.5 py-1.5 rounded-xs cursor-pointer whitespace-nowrap transition-colors duration-100 ease-ease text-fg hover:bg-accent-light hover:text-accent"
          @click="moveToNewWindow"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="9" y="1" width="6" height="6" rx="1" />
            <path d="M4 7v2a2 2 0 002 2h2" />
            <path d="M12 7v2a2 2 0 01-2 2H8" />
          </svg>
          <span>移动到新窗口</span>
        </div>
        <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-xs cursor-pointer whitespace-nowrap transition-colors duration-100 ease-ease text-fg hover:bg-accent-light hover:text-accent" @click="$emit('close-pane')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
          <span>关闭面板</span>
        </div>
        <div class="my-1 mx-2 border-t border-border" />
        <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-xs cursor-pointer whitespace-nowrap transition-colors duration-100 ease-ease text-fg hover:bg-accent-light hover:text-accent" @click="splitPanel('horizontal')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
            <line x1="8" y1="1.5" x2="8" y2="14.5" />
          </svg>
          <span>左右分栏</span>
        </div>
        <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-xs cursor-pointer whitespace-nowrap transition-colors duration-100 ease-ease text-fg hover:bg-accent-light hover:text-accent" @click="splitPanel('vertical')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
            <line x1="1.5" y1="8" x2="14.5" y2="8" />
          </svg>
          <span>上下分栏</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

