<script setup lang="ts">
import { ref, computed } from 'vue'
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
  'open-inspector': [type: string]
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
  <div class="panel-bar" @contextmenu.prevent="onContextMenu">
    <AnchorDropdown
      :options="agentOptions"
      :current-id="activeAgentId"
      @select="$emit('switch-agent', $event)"
    />

    <!-- Session path -->
    <span v-if="sessionInfo" class="breadcrumb" :title="sessionInfo.cwd">
      <span class="breadcrumb__sep">/</span>
      <span class="breadcrumb__dir">{{ dirName }}</span>
      <span v-if="sessionInfo.label && sessionInfo.label !== dirName" class="breadcrumb__sep">/</span>
      <span v-if="sessionInfo.label && sessionInfo.label !== dirName" class="breadcrumb__label">{{ sessionInfo.label }}</span>
    </span>
    <span v-else class="breadcrumb breadcrumb--empty">空面板</span>

    <!-- Notification chips -->
    <div v-if="(doneCount ?? 0) > 0 || (alertCount ?? 0) > 0" class="panel-notifs">
      <span v-if="(doneCount ?? 0) > 0" class="notif-chip notif-chip--done" @click="$emit('open-inspector', 'done')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px"><polyline points="2 6 5 9 10 3"/></svg>
        <span class="notif-chip__num">{{ doneCount }}</span>
      </span>
      <span v-if="(alertCount ?? 0) > 0" class="notif-chip notif-chip--alert" @click="$emit('open-inspector', 'alert')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:10px;height:10px"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8v.5"/></svg>
        <span class="notif-chip__num">{{ alertCount }}</span>
      </span>
    </div>

    <!-- Close panel button (always show when >1 panel) -->
    <button
      v-if="showCloseButton"
      class="panel-close"
      aria-label="关闭面板"
      @click="$emit('close-pane')"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <line x1="3" y1="3" x2="9" y2="9" />
        <line x1="9" y1="3" x2="3" y2="9" />
      </svg>
    </button>

    <!-- 右键上下文菜单 -->
    <Teleport to="body">
      <div v-if="contextMenuVisible" class="fixed inset-0 z-[1000]" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu" />
      <div
        v-if="contextMenuVisible"
        class="ctx-menu"
        :style="{ top: contextMenuPos.y + 'px', left: contextMenuPos.x + 'px' }"
        @click.stop
      >
        <div
          v-if="sessionId"
          class="ctx-item"
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
        <div class="ctx-item" @click="$emit('close-pane')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
          <span>关闭面板</span>
        </div>
        <div class="ctx-divider" />
        <div class="ctx-item" @click="splitPanel('horizontal')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
            <line x1="8" y1="1.5" x2="8" y2="14.5" />
          </svg>
          <span>左右分栏</span>
        </div>
        <div class="ctx-item" @click="splitPanel('vertical')">
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

<style scoped>
.panel-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  height: 40px;
  flex-shrink: 0;
  font-size: 12px;
  /* No border-bottom — fused into content */
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  min-width: 0;
}
.breadcrumb__sep { color: var(--border); }
.breadcrumb__dir { color: var(--fg); font-weight: 500; }
.breadcrumb__label { color: var(--muted); }
.breadcrumb--empty { font-style: italic; opacity: 0.5; }

.panel-notifs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.notif-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.notif-chip--done { background: var(--success-light); color: var(--success); }
.notif-chip--done:hover { outline: 1px solid var(--success); }
.notif-chip--alert { background: var(--danger-light); color: var(--danger); }
.notif-chip--alert:hover { outline: 1px solid var(--danger); }
.notif-chip__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 700;
  color: white;
}
.notif-chip--done .notif-chip__num { background: var(--success); }
.notif-chip--alert .notif-chip__num { background: var(--danger); }

.panel-close {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  margin-left: 4px;
  transition: all 0.15s ease;
}
.panel-close:hover { background: var(--accent-light); color: var(--accent); }
.panel-close svg { width: 10px; height: 10px; }

/* Context menu */
.ctx-menu {
  position: fixed;
  z-index: 1001;
  min-width: 160px;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 2px;
  box-shadow: var(--shadow-sm);
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 2px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s ease;
}
.ctx-item:hover { background: var(--accent-light); color: var(--accent); }
.ctx-divider { margin: 4px 8px; border-top: 1px solid var(--border); }
</style>
