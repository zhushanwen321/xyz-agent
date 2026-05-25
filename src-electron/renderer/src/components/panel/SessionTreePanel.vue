<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useTree } from '../../composables/useTree'
import { Select, Button, ScrollArea } from '../../design-system'
import type { FlatNode, FilterMode } from '../../stores/tree'

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
const flatNodes = computed(() => treeStore.getFlatNodes(props.sessionId))
const hasNodes = computed(() => flatNodes.value.length > 0)

// 选中节点信息
const selectedNode = computed<FlatNode | null>(() => {
  const sid = sessionState.value.selectedId
  if (!sid) return null
  return flatNodes.value.find(fn => fn.node.id === sid) ?? null
})

// 过滤选项
const filterOptions = [
  { label: 'All', value: 'all' },
  { label: 'No Tools', value: 'no-tools' },
  { label: 'User', value: 'user' },
  { label: 'Labeled', value: 'labeled' },
]

function handleFilterChange(val: string | number) {
  treeStore.setFilterMode(props.sessionId, val as FilterMode)
}

function handleSelectNode(id: string) {
  const current = sessionState.value.selectedId
  treeStore.selectNode(props.sessionId, current === id ? null : id)
}

const isOperating = ref(false)

function handleNavigate() {
  if (isOperating.value) return
  const sid = sessionState.value.selectedId
  if (!sid) return
  isOperating.value = true
  navigate(props.sessionId, sid)
  // 3s 后自动解锁，防止结果未到达时永久禁用
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

function handleClose() {
  treeStore.setPanelOpen(props.sessionId, false)
  emit('close')
}

// 图标映射
function getIconClass(role?: string): string {
  if (role === 'user') return 'icon-u'
  if (role === 'assistant') return 'icon-a'
  return 'icon-s'
}

function getIconChar(role?: string): string {
  if (role === 'user') return 'U'
  if (role === 'assistant') return 'A'
  return 'S'
}

/** 首行截断 */
function truncate(text: string, max: number): string {
  if (!text) return ''
  const first = text.split('\n')[0]
  return first.length > max ? first.slice(0, max) + '...' : first
}

// sessionId 变化或首次挂载时加载数据（watch + immediate 替代 onMounted + watch 组合，避免重复请求）
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
      <span v-if="sessionState.leafId" class="text-[10px] text-[var(--muted)]">
        Leaf: {{ sessionState.leafId.slice(0, 8) }}
      </span>
      <Select
        :model-value="sessionState.filterMode"
        :options="filterOptions"
        placeholder="Filter"
        class="!h-6 !text-[10px] !w-[90px] !py-0"
        @update:model-value="handleFilterChange"
      />
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
          v-for="fn in flatNodes"
          :key="fn.node.id"
          :class="[
            'tree-node',
            fn.onPath && 'on-path',
            fn.isLeaf && 'is-leaf',
            sessionState.selectedId === fn.node.id && 'selected',
          ]"
          :style="{ paddingLeft: (14 + fn.depth * 24) + 'px' }"
          @click="handleSelectNode(fn.node.id)"
        >
          <!-- Branch indent lines -->
          <div v-if="fn.depth > 0" class="tree-indent-lines" :style="{ width: (fn.depth * 24) + 'px' }">
            <span
              v-for="i in fn.depth"
              :key="i"
              class="indent-line"
            />
          </div>

          <!-- Type icon -->
          <span :class="['tree-icon', getIconClass(fn.node.role)]">
            {{ getIconChar(fn.node.role) }}
          </span>

          <!-- Text -->
          <span :class="['tree-text', fn.onPath ? 'text-[var(--fg)]' : 'text-[var(--muted)]']">
            {{ truncate(fn.node.text, 70) }}
          </span>

          <!-- Label -->
          <span v-if="fn.node.label" class="tree-label">
            {{ fn.node.label }}
          </span>

          <!-- Leaf indicator -->
          <span v-if="fn.isLeaf" class="leaf-dot" />
        </div>
      </template>
    </ScrollArea>

    <!-- Action bar -->
    <div
      v-if="selectedNode && !selectedNode.isLeaf"
      class="flex items-center gap-2 px-3.5 py-1.5 border-t border-solid border-[var(--border)] bg-[var(--surface)]"
    >
      <span class="text-[10px] text-[var(--muted)] flex-1">
        {{ selectedNode.node.role === 'user' ? 'User message' : selectedNode.node.role === 'assistant' ? 'Assistant response' : 'Branch summary' }}
      </span>
      <Button size="sm" variant="outline" :disabled="isOperating" @click="handleFork">
        Fork from here
      </Button>
      <Button
        v-if="sessionState.navigateCapable"
        size="sm"
        :disabled="isOperating"
        @click="handleNavigate"
      >
        Navigate here
      </Button>
    </div>
  </div>
</template>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding-right: 14px;
  cursor: pointer;
  transition: background 0.1s;
  position: relative;
}
.tree-node:hover {
  background: rgba(255, 255, 255, 0.025);
}
.tree-node.selected {
  background: var(--accent-light);
}
.tree-node.on-path {
  background: rgba(0, 245, 212, 0.03);
}
.tree-node.is-leaf {
  background: rgba(0, 245, 212, 0.05);
}

.tree-indent-lines {
  position: absolute;
  left: 14px;
  display: flex;
  height: 100%;
}
.indent-line {
  width: 24px;
  position: relative;
  flex-shrink: 0;
}
.indent-line::after {
  content: '';
  position: absolute;
  left: 11px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
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
.icon-s {
  color: var(--warning);
  background: var(--warning-light);
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

.tree-label {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--accent-light);
  color: var(--accent);
  font-weight: 500;
  flex-shrink: 0;
}

.leaf-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
  margin-left: 6px;
  box-shadow: 0 0 6px rgba(0, 245, 212, 0.4);
  animation: leaf-glow 2s ease infinite;
}

@keyframes leaf-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
