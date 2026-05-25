<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useTree } from '../../composables/useTree'
import { Button, ScrollArea } from '../../design-system'
import type { PathNode } from '../../stores/tree'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const treeStore = useTreeStore()
const { fetchTree, navigate, fork, requestCapability } = useTree()

// Session 分区状态
const sessionState = computed(() => treeStore.getSessionState(props.sessionId))
const pathNodes = computed(() => treeStore.getActivePath(props.sessionId))
const hasNodes = computed(() => pathNodes.value.length > 0)

// 选中节点信息
const selectedNode = computed<PathNode | null>(() => {
  const sid = sessionState.value.selectedId
  if (!sid) return null
  return pathNodes.value.find(pn => pn.entryId === sid) ?? null
})

const isOperating = ref(false)

function handleSelectNode(entryId: string) {
  const current = sessionState.value.selectedId
  treeStore.selectNode(props.sessionId, current === entryId ? null : entryId)
}

function handleNavigate() {
  if (isOperating.value) return
  const sid = sessionState.value.selectedId
  if (!sid) return
  isOperating.value = true
  navigate(props.sessionId, sid)
  setTimeout(() => { isOperating.value = false }, 3000)
}

function handleFork() {
  if (isOperating.value) return
  const sid = sessionState.value.selectedId
  if (!sid) return
  isOperating.value = true
  fork(props.sessionId, sid)
  setTimeout(() => { isOperating.value = false }, 3000)
}

/** 点击分支 tab → navigate 到该分支 */
function handleBranchClick(targetId: string) {
  if (isOperating.value) return
  isOperating.value = true
  navigate(props.sessionId, targetId)
  setTimeout(() => { isOperating.value = false }, 3000)
}

function handleClose() {
  treeStore.setPanelOpen(props.sessionId, false)
  emit('close')
}

// sessionId 变化或首次挂载时加载数据
watch(() => props.sessionId, (newSid: string) => {
  if (treeStore.getSessionState(newSid).tree.length === 0) {
    fetchTree(newSid)
  }
  requestCapability(newSid)
}, { immediate: true })
</script>

<template>
  <div class="flex flex-col h-full bg-[var(--surface)] border-t border-solid border-[var(--border)]">
    <!-- Toolbar -->
    <div class="flex items-center gap-2 px-3.5 py-2 border-b border-solid border-[var(--border)]">
      <span class="text-xs font-semibold text-[var(--fg)] flex-1">Session Tree</span>
      <Button size="icon" variant="ghost" aria-label="Close" @click="handleClose">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </Button>
    </div>

    <!-- Node list -->
    <ScrollArea class="flex-1 min-h-0">
      <div v-if="sessionState.isLoading" class="flex items-center justify-center py-8 text-xs text-[var(--muted)]">
        Loading...
      </div>
      <div v-else-if="sessionState.error" class="px-3.5 py-3 text-xs text-[var(--danger)]">
        {{ sessionState.error }}
      </div>
      <div v-else-if="!hasNodes" class="flex items-center justify-center py-8 text-xs text-[var(--muted)]">
        No tree data available
      </div>
      <template v-else>
        <div
          v-for="pn in pathNodes"
          :key="pn.entryId"
        >
          <!-- 节点行 -->
          <div
            :class="[
              'tree-node',
              sessionState.selectedId === pn.entryId && 'selected',
            ]"
            @click="handleSelectNode(pn.entryId)"
          >
            <!-- 角色图标 -->
            <span :class="['tree-icon', pn.role === 'user' ? 'icon-u' : 'icon-a']">
              {{ pn.role === 'user' ? 'U' : 'A' }}
            </span>

            <!-- 文本 -->
            <span :class="['tree-text', pn.text ? 'text-[var(--fg)]' : 'text-[var(--muted)]']">
              {{ pn.text || '...' }}
            </span>
          </div>

          <!-- 分支 tab bar -->
          <div v-if="pn.branchTabs && pn.branchTabs.length > 1" class="branch-tabs">
            <div
              v-for="(tab, idx) in pn.branchTabs"
              :key="idx"
              role="tab"
              :aria-selected="tab.isActive"
              :class="['branch-tab', tab.isActive && 'branch-tab--active']"
              @click.stop="tab.isActive ? null : handleBranchClick(tab.targetId)"
            >
              {{ tab.isActive ? '\u25CF ' : '' }}{{ tab.label }}
            </div>
          </div>
        </div>
      </template>
    </ScrollArea>

    <!-- Action bar -->
    <div
      v-if="selectedNode"
      class="flex items-center gap-2 px-3.5 py-1.5 border-t border-solid border-[var(--border)] bg-[var(--surface)]"
    >
      <span class="text-[10px] text-[var(--muted)] flex-1">
        {{ selectedNode.role === 'user' ? 'User message' : 'Assistant response' }}
      </span>
      <Button
        v-if="selectedNode.role === 'user'"
        size="sm"
        variant="outline"
        :disabled="isOperating"
        title="从该用户消息创建新 session"
        @click="handleFork"
      >
        Fork
      </Button>
      <Button
        v-if="sessionState.navigateCapable"
        size="sm"
        :disabled="isOperating"
        title="定位到该节点"
        @click="handleNavigate"
      >
        Navigate
      </Button>
    </div>
  </div>
</template>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 14px;
  cursor: pointer;
  transition: background 0.1s;
}
.tree-node:hover {
  background: rgba(255, 255, 255, 0.025);
}
.tree-node.selected {
  background: var(--accent-light);
}

.tree-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 700;
  border-radius: 2px;
}
.icon-u {
  color: var(--agent);
  background: rgba(91, 192, 235, 0.1);
}
.icon-a {
  color: var(--accent);
  background: var(--accent-light);
}

.tree-text {
  flex: 1;
  min-width: 0;
  padding: 0 8px;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 分支 tab bar */
.branch-tabs {
  display: flex;
  gap: 0;
  padding: 0 14px 0 40px;
  border-bottom: 1px solid var(--border);
}

.branch-tab {
  font-size: 10px;
  padding: 4px 10px;
  background: transparent;
  color: var(--muted);
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
  transition: color 0.15s, border-color 0.15s;
  user-select: none;
}

.branch-tab:hover {
  color: var(--fg);
  background: rgba(255, 255, 255, 0.02);
}

.branch-tab--active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 500;
}
</style>
