<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import { usePaneStore } from '../../stores/pane'
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
    paneId?: string
    sessionId?: string | null
    doneCount?: number
    alertCount?: number
  }>(),
  {
    paneId: '',
  }
)

defineEmits<{
  'switch-agent': [id: string]
  'open-drawer': [type: string]
  'close-pane': []
}>()

const paneStore = usePaneStore()
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

const showCloseButton = computed(() => paneStore.paneCount > 1)

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
  if (!props.sessionId || !props.paneId) return
  try {
    await windowStore.createWindow(props.sessionId)
    paneStore.unbindSession(props.paneId)
  } catch {
    // 窗口创建失败时不做额外处理
  }
}

function splitPane(direction: 'horizontal' | 'vertical') {
  closeContextMenu()
  if (!props.paneId) return
  paneStore.splitPane(props.paneId, direction)
}
</script>

<template>
  <div class="panel-bar" @contextmenu.prevent="onContextMenu">
    <AnchorDropdown
      :options="agentOptions"
      :current-id="activeAgentId"
      @select="$emit('switch-agent', $event)"
    />

    <!-- Session 标识：目录名 / session label -->
    <span v-if="sessionInfo" class="panel-session" :title="sessionInfo.cwd">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
        <path d="M2 4a1 1 0 011-1h3.586a1 1 0 01.707.293l1.414 1.414a1 1 0 00.707.293H13a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/>
      </svg>
      <span class="panel-session__dir">{{ dirName }}</span>
      <span v-if="sessionInfo.label && sessionInfo.label !== dirName" class="panel-session__sep">/</span>
      <span v-if="sessionInfo.label && sessionInfo.label !== dirName" class="panel-session__label">{{ sessionInfo.label }}</span>
    </span>
    <span v-else class="panel-session panel-session--empty">空面板</span>

    <div v-if="(doneCount ?? 0) > 0 || (alertCount ?? 0) > 0" class="panel-notifs">
      <span v-if="(doneCount ?? 0) > 0" class="pn-chip pn-chip--done" role="button" tabindex="0" @click="$emit('open-drawer', 'done')" @keydown.enter="$emit('open-drawer', 'done')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px"><polyline points="2 6 5 9 10 3"/></svg>
        <span class="pn-chip__num">{{ doneCount }}</span>
      </span>
      <span v-if="(alertCount ?? 0) > 0" class="pn-chip pn-chip--alert" role="button" tabindex="0" @click="$emit('open-drawer', 'alert')" @keydown.enter="$emit('open-drawer', 'alert')">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:10px;height:10px"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8v.5"/></svg>
        <span class="pn-chip__num">{{ alertCount }}</span>
      </span>
    </div>

    <Button
      v-if="showCloseButton"
      variant="ghost"
      size="icon"
      class="panel-close"
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
      <div v-if="contextMenuVisible" class="context-backdrop" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu" />
      <div
        v-if="contextMenuVisible"
        class="context-menu"
        :style="{ top: contextMenuPos.y + 'px', left: contextMenuPos.x + 'px' }"
        @click.stop
      >
        <div
          v-if="sessionId"
          class="context-menu__item"
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
        <div class="context-menu__item" @click="$emit('close-pane')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
          <span>关闭面板</span>
        </div>
        <div class="context-menu__divider" />
        <div class="context-menu__item" @click="splitPane('horizontal')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
            <line x1="8" y1="1.5" x2="8" y2="14.5" />
          </svg>
          <span>左右分栏</span>
        </div>
        <div class="context-menu__item" @click="splitPane('vertical')">
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
  padding: 0 12px;
  height: 36px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  font-size: 12px;
}

/* Close button: always visible in multi-pane mode */
.panel-close {
  margin-left: auto;
  flex-shrink: 0;
}

/* Session identity in panel bar */
.panel-session {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  min-width: 0;
}
.panel-session--empty {
  font-style: italic;
  opacity: 0.5;
}
.panel-session__dir {
  color: var(--fg);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
}
.panel-session__sep {
  color: var(--border);
}
.panel-session__label {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Inline notifications */
.panel-notifs {
  display: flex;
  align-items: center;
  gap: 5px;
}
.pn-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 100px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  transition: all 0.15s var(--ease);
  border: 1px solid transparent;
}
.pn-chip--done {
  background: var(--success-light);
  color: var(--success);
}
.pn-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.pn-chip--done:hover {
  border-color: var(--success);
}
.pn-chip--alert {
  background: var(--danger-light);
  color: var(--danger);
}
.pn-chip--alert:hover {
  border-color: var(--danger);
}
.pn-chip__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  font-size: 9px;
  font-weight: 700;
  color: white;
}
.pn-chip--done .pn-chip__num {
  background: var(--success);
}
.pn-chip--alert .pn-chip__num {
  background: var(--danger);
  animation: pulse-dot 2s infinite;
}
@keyframes pulse-dot {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}

/* ── 右键上下文菜单 ─────────────────────────────────────────────── */
.context-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.context-menu {
  position: fixed;
  z-index: 1001;
  min-width: 160px;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font-size: 12px;
  line-height: 1.4;
  color: var(--fg);
}

.context-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-xs, 4px);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s var(--ease, ease);
  color: var(--fg);
  fill: none;
  stroke: var(--fg);
}
.context-menu__item:hover {
  background: var(--accent-light);
  color: var(--accent);
  stroke: var(--accent);
}

.context-menu__divider {
  margin: 4px 8px;
  border-top: 1px solid var(--border);
}
</style>
