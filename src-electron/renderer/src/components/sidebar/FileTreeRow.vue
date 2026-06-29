<template>
  <!--
    递归行（#4，GAP-S6 用 shared FileNode 统一）：
    - 目录（可折叠，展开态从 fileTreeStore.expandedPaths 读，toggle 走 useFileTree）
    - 文件（图标按扩展名 + git overlay 角标，点击触发 selectFile）
    data-testid 用 path（E2E 选择器），dir/file 区分前缀
  -->
  <div>
    <!-- 目录 -->
    <div
      v-if="node.type === 'dir'"
      class="flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-[11px] transition-colors hover:bg-surface-hover"
      :style="{ paddingLeft: `${depth * 10 + 8}px` }"
      :data-testid="`file-tree-dir-${node.path}`"
      @click="toggle"
    >
      <ChevronRight
        class="size-3 shrink-0 text-subtle transition-transform"
        :class="{ 'rotate-90': isExpanded }"
      />
      <Folder class="size-3.5 shrink-0 text-muted" />
      <span class="flex-1 truncate" :class="node.ignored ? 'text-subtle italic' : 'text-muted'">{{ node.name }}</span>
    </div>
    <template v-if="node.type === 'dir' && isExpanded">
      <!-- 展开在途：loading 指示（nodeStates[path].status==='loading'） -->
      <div
        v-if="dirState === 'loading'"
        class="flex items-center gap-1.5 py-1 pr-2 text-[10.5px] text-subtle"
        :style="{ paddingLeft: `${(depth + 1) * 10 + 8}px` }"
        :data-testid="`file-tree-loading-${node.path}`"
      >
        <Loader2 class="size-3 animate-spin opacity-60" />
        <span>加载...</span>
      </div>
      <div
        v-else-if="dirState === 'error'"
        class="flex items-center gap-1.5 py-1 pr-2 text-[10.5px] text-danger"
        :style="{ paddingLeft: `${(depth + 1) * 10 + 8}px` }"
        :data-testid="`file-tree-error-${node.path}`"
      >
        <AlertCircle class="size-3" />
        <span>加载失败（点击重试）</span>
      </div>
      <template v-else>
        <FileTreeRow
          v-for="child in node.children"
          :key="child.path"
          :node="child"
          :depth="depth + 1"
          :session-id="sessionId"
        />
        <!-- 已加载但空目录 -->
        <div
          v-if="node.children && node.children.length === 0"
          class="py-1 pr-2 text-[10.5px] text-subtle italic"
          :style="{ paddingLeft: `${(depth + 1) * 10 + 18}px` }"
        >
          （空目录）
        </div>
      </template>
    </template>

    <!-- 文件 -->
    <div
      v-else
      class="flex cursor-pointer items-center gap-2 rounded-md py-1 pr-2 transition-colors hover:bg-surface-hover"
      :class="{ 'bg-accent-soft': isSelected }"
      :style="{ paddingLeft: `${depth * 10 + 18}px` }"
      :data-testid="`file-tree-file-${node.path}`"
      @click="onSelectFile"
    >
      <component :is="fileIcon" class="size-3.5 shrink-0" :class="fileIconColor" />
      <span
        class="flex-1 truncate font-mono text-[12px]"
        :class="[
          node.ignored ? 'text-subtle italic' : 'text-fg',
          isSelected ? 'font-semibold text-accent' : '',
        ]"
      >{{ node.name }}</span>
      <!-- git overlay 角标（D-012 树/标注分离：从 gitOverlay 取 status，非 node 字段） -->
      <span
        v-if="gitBadge"
        class="rounded-sm px-1 py-0.5 font-mono text-[10px]"
        :class="gitBadgeClass"
      >{{ gitBadge }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, Folder, FileText, FileCode, FileJson, Loader2, AlertCircle } from '@lucide/vue'
import type { FileNode } from '@xyz-agent/shared'
import { useFileTreeStore } from '@/stores/fileTree'
import { useFileTree } from '@/composables/features/useFileTree'
import { useSideDrawer } from '@/composables/features/useSideDrawer'

const props = defineProps<{
  /** 节点（shared FileNode，GAP-S6 统一） */
  node: FileNode
  depth: number
  /** 当前 session id（展开态/overlay 都 per-session） */
  sessionId: string
}>()

const store = useFileTreeStore()
const { expandNode, collapseNode, selectFile } = useFileTree()
const drawer = useSideDrawer()

/** 展开态从 store 读（D-019 rehydrate：切回 session 自动恢复） */
const isExpanded = computed(() => store.getExpanded(props.sessionId).has(props.node.path))

/** 目录加载态（loading/error/其它）—— 用于展开在途指示 */
const dirState = computed(() => store.getNodeState(props.sessionId, props.node.path).status)

/** 选中态（selectedPath 全局焦点） */
const isSelected = computed(() => store.selectedPath === props.node.path)

/** git overlay 角标（D-012：从 gitOverlay 取 status） */
const gitStatus = computed(() => store.getGitStatus(props.sessionId, props.node.path)?.status)

const gitBadge = computed(() => {
  switch (gitStatus.value) {
    case 'modified': return 'M'
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'unmerged': return 'U'
    case 'renamed': return 'R'
    case 'untracked': return 'A' // T2.8b: untracked ?? → 绿 A
    default: return ''
  }
})

/** M/A/D/U/R 角标配色（design-tokens 语义色） */
const gitBadgeClass = computed(() => {
  switch (gitStatus.value) {
    case 'modified': return 'bg-warning/12 text-warning'
    case 'added': return 'bg-success/12 text-success'
    case 'deleted': return 'bg-danger/12 text-danger'
    case 'unmerged': return 'bg-danger/16 text-danger font-semibold'
    case 'renamed': return 'bg-info/12 text-info'
    case 'untracked': return 'bg-success/12 text-success'
    default: return ''
  }
})

/** 展开/折叠目录（loaded 复用缓存 / loading 幂等 / error 重试，全在 useFileTree.expandNode） */
function toggle(): void {
  if (isExpanded.value) {
    collapseNode(props.sessionId, props.node.path)
  } else {
    void expandNode(props.sessionId, props.node.path)
  }
}

/**
 * 选中文件（#6 预览触发，code-architecture §4 功能3 时序：点文件→SideDrawer.openDetailPane）。
 * selectFile 设 store.selectedPath（useDetailPane watch 自动加载内容），
 * drawer.open('detail') 打开抽屉切到 detail tab（DetailPane 挂载）。
 */
function onSelectFile(): void {
  selectFile(props.node.path)
  drawer.open('detail')
}

const ext = computed(() => {
  const parts = props.node.name.split('.')
  return parts.length > 1 ? (parts.pop() ?? '') : ''
})

/** 文件图标按扩展名 */
const fileIcon = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': case 'js': case 'cjs': case 'mjs': return FileCode
    case 'json': return FileJson
    default: return FileText
  }
})

/** 图标色按扩展名（避开 M/A/D 的橙绿红） */
const fileIconColor = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': return 'text-info'
    case 'vue': return 'text-success'
    case 'json': return 'text-warning'
    case 'md': return 'text-muted'
    default: return 'text-subtle'
  }
})
</script>
