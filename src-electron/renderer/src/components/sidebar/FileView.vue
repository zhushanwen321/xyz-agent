<template>
  <!--
    展示组件 · 文件视图（#4，draft-five-states §B）。
    完整文件树浏览器（D-009 懒加载默认顶层）：data-testid 标注供 E2E 选择器。

    数据来源（W4 重写，替代旧「改动文件列表」）：
    - fileTreeStore.tree（per-session FileNode[]）+ expandedPaths（D-019 rehydrate）
    - gitOverlay 提供 M/A/D/U 角标（D-012 树/标注分离）
    - 编排走 useFileTree（loadTree/expandNode/collapseNode/selectFile/setFilter）
    - sessionId 由 Sidebar 注入（当前 active session），切 session 触发 loadTree
  -->
  <ScrollArea class="h-full">
    <div class="flex flex-col gap-0.5 px-1" data-testid="file-view-root">
      <!-- 头部：当前 session 标签 + 分支 -->
      <div v-if="sessionLabel" class="truncate px-2 py-1.5 font-mono text-[10.5px] text-muted">
        <span class="text-fg">{{ sessionLabel }}</span>
        <span v-if="branch" class="opacity-60"> · </span>
        <span v-if="branch" class="text-accent">{{ branch }}</span>
      </div>

      <!-- 过滤框：实时按 path 模糊匹配（store.filterText，useFileTree.setFilter 驱动） -->
      <div class="relative px-2 pb-1.5">
        <Search class="pointer-events-none absolute left-4 top-1/2 size-3 -translate-y-1/2 text-subtle" />
        <Input
          :model-value="store.filterText"
          class="h-6 pl-6 pr-2 text-[11px]"
          placeholder="过滤文件..."
          data-testid="file-filter-input"
          @update:model-value="onFilter"
        />
      </div>

      <!-- showIgnored 开关（D-020/D-004：显示被 gitignore 忽略的文件，灰斜体渲染） -->
      <div class="flex items-center justify-end gap-1 px-2 pb-1">
        <Button
          variant="ghost"
          class="h-5 gap-1 rounded-sm px-1.5 text-[10px]"
          :class="store.showIgnored ? 'text-accent' : 'text-subtle'"
          :title="store.showIgnored ? '隐藏忽略文件' : '显示忽略文件'"
          data-testid="file-show-ignored-toggle"
          @click="onToggleShowIgnored"
        >
          <EyeOff v-if="store.showIgnored" class="size-3" />
          <Eye v-else class="size-3" />
          <span>忽略项</span>
        </Button>
      </div>

      <!-- 加载态（loadTree 在途） -->
      <div
        v-if="rootState.status === 'loading'"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="file-loading"
      >
        <Loader2 class="size-4 animate-spin text-subtle opacity-60" />
        <p class="text-[11.5px] text-subtle opacity-60">加载文件树...</p>
      </div>

      <!-- 错误态（loadTree 失败，可重试） -->
      <div
        v-else-if="rootState.status === 'error'"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="file-error"
      >
        <AlertCircle class="size-5 text-danger opacity-60" />
        <p class="text-[11.5px] text-muted">加载失败（{{ rootState.reason ?? 'unknown' }}）</p>
        <Button variant="ghost" class="h-6 text-[11px] text-accent" data-testid="file-retry" @click="retry">重试</Button>
      </div>

      <!-- 空态：loaded 但无节点（空目录 cwd）或过滤无匹配 -->
      <div
        v-else-if="visibleNodes.length === 0"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center"
        data-testid="file-empty"
      >
        <component :is="hasFilter ? SearchX : FolderOpen" class="size-5 text-subtle opacity-50" />
        <p class="text-[11.5px] text-subtle opacity-55">{{ hasFilter ? '无匹配文件' : '暂无文件' }}</p>
      </div>

      <!-- 文件树（visibleNodes = 过滤后的顶层节点） -->
      <div v-else class="mt-1 flex flex-col gap-px">
        <FileTreeRow
          v-for="node in visibleNodes"
          :key="node.path"
          :node="node"
          :depth="0"
          :session-id="sessionId"
        />
      </div>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, watch, onMounted, onBeforeUnmount, toRef } from 'vue'
import { FolderOpen, Search, SearchX, Loader2, AlertCircle, Eye, EyeOff } from '@lucide/vue'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import FileTreeRow from './FileTreeRow.vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { useFileTree } from '@/composables/features/useFileTree'
import type { FileNode } from '@xyz-agent/shared'

const props = defineProps<{
  /** 当前 active session id（Sidebar 注入，切 session 触发 loadTree） */
  sessionId: string
  sessionLabel?: string
  branch?: string
}>()

const store = useFileTreeStore()
const { loadTree, setFilter, setupInvalidation, toggleShowIgnored } = useFileTree()

/** 跨 store 失效 unwatch 句柄（onBeforeUnmount 清理，W6 #3.11） */
let unwatchInvalidation: (() => void) | null = null

/** 根节点加载态（path='' 的 NodeState） */
const rootState = computed(() => store.getNodeState(props.sessionId, ''))

/** 当前 session 的顶层 FileNode[]（未缓存时为 undefined → 视为空） */
const treeNodes = computed<FileNode[]>(() => store.getTree(props.sessionId) ?? [])

/** 过滤命中判定：递归检查节点子树是否含匹配关键词的路径（保留含命中的整条祖先链） */
function nodeMatchesFilter(node: FileNode, q: string): boolean {
  if (node.path.toLowerCase().includes(q)) return true
  if (node.children) return node.children.some((c) => nodeMatchesFilter(c, q))
  return false
}

const hasFilter = computed(() => store.filterText.trim().length > 0)

/** 过滤后的可见顶层节点（无过滤 = 全量；有过滤 = 保留子树含命中的顶层节点） */
const visibleNodes = computed<FileNode[]>(() => {
  const q = store.filterText.trim().toLowerCase()
  if (!q) return treeNodes.value
  return treeNodes.value.filter((n) => nodeMatchesFilter(n, q))
})

/** 过滤输入：透传 useFileTree.setFilter（#4） */
function onFilter(value: string | number): void {
  setFilter(String(value))
}

/** 错误态重试：重 loadTree（useFileTree 内 loaded 复用，error 态会重发） */
function retry(): void {
  void loadTree(props.sessionId)
}

/** 切换 showIgnored（D-020：显示/隐藏 gitignore 忽略项，切换后重 loadTree 拿 ignored 节点） */
function onToggleShowIgnored(): void {
  toggleShowIgnored()
  // 切换后需重 loadTree（showIgnored 影响 FileService 过滤，store 缓存的 tree 不含 ignored 节点）
  // 清缓存重拉：直接调 loadTree，但因已缓存会跳过。这里强制清该 session 的 tree 后重拉。
  store.clearSession(props.sessionId)
  void loadTree(props.sessionId)
}

/**
 * 切 session 触发 loadTree（首加载）。
 * useFileTree.loadTree 内部已缓存复用 + rehydrate 展开（D-019）。
 */
watch(
  () => props.sessionId,
  (sid) => {
    if (sid) void loadTree(sid)
  },
  { immediate: true },
)

/**
 * [W6 #3.11] 跨 store 失效：setupInvalidation watch chat store fileChanges 变化 → invalidate。
 * onMounted 建立 watch，onBeforeUnmount 清理（setupInvalidation 返回 unwatch 函数）。
 */
onMounted(() => {
  unwatchInvalidation = setupInvalidation(toRef(props, 'sessionId'))
})

onBeforeUnmount(() => {
  unwatchInvalidation?.()
  unwatchInvalidation = null
})
</script>
