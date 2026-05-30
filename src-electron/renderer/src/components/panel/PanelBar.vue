<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePanelStore } from '../../stores/panel'
import { useSessionStore } from '../../stores/session'
import { useWindowStore } from '../../stores/window'
import { useTreeStore } from '../../stores/tree'
import { useTree } from '../../composables/useTree'
import AnchorDropdown from './AnchorDropdown.vue'
import SessionTreePanel from './SessionTreePanel.vue'

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
const treeStore = useTreeStore()
const { fetchTree } = useTree()

const sessionInfo = computed(() => {
  if (!props.sessionId) return null
  return sessionStore.sessions.find(s => s.id === props.sessionId) ?? null
})

const dirParts = computed(() => {
  const cwd = sessionInfo.value?.cwd
  if (!cwd) return []
  const segs = cwd.replace(/\/$/, '').split('/').filter(Boolean)
  return segs.slice(-2)
})

const gitBranch = computed(() => sessionInfo.value?.gitBranch)

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

// ── Session Tree ──────────────────────────────────────────────────
const treeState = computed(() => props.sessionId ? treeStore.getSessionState(props.sessionId) : null)
const isTreeOpen = computed(() => treeState.value?.isOpen ?? false)
const branchCount = computed(() => treeState.value?.branchCount ?? 0)

function toggleTree() {
  if (!props.sessionId) return
  const wasOpen = treeState.value?.isOpen ?? false
  treeStore.togglePanel(props.sessionId)
  if (!wasOpen) fetchTree(props.sessionId)
}

function closeTree() {
  if (!props.sessionId) return
  treeStore.setPanelOpen(props.sessionId, false)
}

// ESC 关闭 tree 面板（仅在 tree 面板打开且无其他聚焦元素时响应）
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !isTreeOpen.value) return
  // 如果焦点在 input/textarea/contenteditable 内，让组件自己处理 ESC
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
  closeTree()
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="panel-bar" @contextmenu.prevent="onContextMenu">
    <AnchorDropdown
      :options="agentOptions"
      :current-id="activeAgentId"
      @select="$emit('switch-agent', $event)"
    />

    <!-- Session path + git branch -->
    <span v-if="sessionInfo" class="breadcrumb" :title="sessionInfo.cwd">
      <template v-for="(part, idx) in dirParts" :key="idx">
        <span class="breadcrumb__sep">/</span>
      </template>
      <span class="breadcrumb__dir">{{ dirParts[0] }}</span>
      <span v-if="dirParts[1]" class="breadcrumb__sep">/</span>
      <span v-if="dirParts[1]" class="breadcrumb__dir">{{ dirParts[1] }}</span>
      <span v-if="gitBranch" class="breadcrumb__branch">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        {{ gitBranch }}
      </span>
    </span>
    <span v-else class="breadcrumb breadcrumb--empty">空面板</span>

    <!-- Tree trigger -->
    <!-- eslint-disable-next-line taste/no-native-html-elements -- compact icon trigger, consistent with panel-close -->
    <button
      v-if="sessionId"
      class="tree-trigger"
      :class="{ 'tree-trigger--active': isTreeOpen }"
      aria-label="Session tree"
      @click="toggleTree"
    >
      <!-- git-branch icon -->
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="6" y1="3" x2="6" y2="15"/>
        <circle cx="18" cy="6" r="3"/>
        <circle cx="6" cy="18" r="3"/>
        <path d="M18 9a9 9 0 0 1-9 9"/>
      </svg>
      <span v-if="branchCount > 0" class="tree-badge">{{ branchCount }}</span>
    </button>

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

    <!-- Tree overlay panel -->
    <div v-if="isTreeOpen && sessionId" class="tree-overlay" @keydown.escape="closeTree">
      <SessionTreePanel :session-id="sessionId" @close="closeTree" />
    </div>

    <!-- Tree backdrop: click outside 关闭 -->
    <Teleport to="body">
      <div v-if="isTreeOpen" class="fixed inset-0 z-40" @click="closeTree" />
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
  position: relative;
}

.tree-trigger {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: 1px;
  transition: all 0.15s ease;
}
.tree-trigger:hover { background: var(--accent-light); color: var(--accent); }
.tree-trigger--active { color: var(--accent); background: var(--accent-light); }

.tree-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 1px;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
  color: white;
  background: var(--accent);
}

.tree-overlay {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: min(640px, calc(100vh - 44px));
  z-index: 50;
  background: var(--surface);
  border: 1px solid var(--border);
  border-top: none;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
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
.breadcrumb__branch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 6px;
  padding: 0 5px;
  height: 16px;
  border-radius: 1px;
  font-size: 10px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-light);
}
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
  border-radius: 1px;
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
  border-radius: 1px;
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
  border-radius: 1px;
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
  border-radius: 1px;
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
  border-radius: 1px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s ease;
}
.ctx-item:hover { background: var(--accent-light); color: var(--accent); }
.ctx-divider { margin: 4px 8px; border-top: 1px solid var(--border); }
</style>
