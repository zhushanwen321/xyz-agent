<template>
  <!--
    递归行（#4，GAP-S6 用 shared FileNode 统一）：
    - 目录（可折叠，展开态从 fileTreeStore.expandedPaths 读，toggle 走 useFileTree）
    - 文件（图标按扩展名 + git overlay 角标，点击触发 selectFile）
    data-testid 用 path（E2E 选择器），dir/file 区分前缀

    [HISTORICAL v-if/v-else 链断裂事故] 目录行 + 展开子节点必须包进同一个
    <template v-if="node.type === 'dir'">，文件行 v-else 紧随其后。
    原实现把「展开子节点」写成独立的 <template v-if="...&& isExpanded">，插在目录 v-if
    与文件 v-else 之间 → v-else 错误绑定到展开判断 → 折叠目录时 v-else 命中，同一节点
    被同时渲染为目录行 + 同名文件行（「文件打不开」假象）。绝不可在目录 v-if 与文件 v-else
    之间插入任何条件块。
  -->
  <div>
    <!-- 目录（行 + 展开子节点同属一个 v-if 块，保证下方文件 v-else 正确绑定） -->
    <template v-if="node.type === 'dir'">
      <div
        class="flex w-max min-w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-2 font-mono text-[12px] transition-colors hover:bg-surface-hover"
        :style="rowPaddingStyle"
        :data-testid="`file-tree-dir-${node.path}`"
        @click="toggle"
      >
        <span :class="chevronSlotClass" data-testid="chevron-slot">
          <ChevronRight
            class="size-3 text-subtle transition-transform"
            :class="{ 'rotate-90': isExpanded }"
          />
        </span>
        <Folder class="size-3.5 shrink-0 text-muted" />
        <span class="shrink whitespace-nowrap" :class="node.ignored ? 'text-subtle italic' : 'text-fg'">{{ node.name }}</span>
        <!-- W2 目录改动数徽章（子树改动文件数，>0 才显） -->
        <span
          v-if="dirChangeCount > 0"
          class="shrink-0 rounded-sm bg-accent-soft px-1 py-0.5 font-mono text-[10px] text-accent"
          :data-testid="`file-tree-dir-badge-${node.path}`"
        >{{ dirChangeCount > 999 ? '999+' : dirChangeCount }}</span>
      </div>

      <!-- 展开态子节点 -->
      <template v-if="isExpanded">
        <!-- 展开在途：loading 指示（nodeStates[path].status==='loading'） -->
        <div
          v-if="dirState === 'loading'"
          class="flex items-center gap-1.5 py-1 pr-2 font-mono text-[10.5px] text-subtle"
          :style="childHintPaddingStyle"
          :data-testid="`file-tree-loading-${node.path}`"
        >
          <span :class="chevronSlotClass" data-testid="chevron-slot" />
          <Loader2 class="size-3 animate-spin opacity-60" />
          <span>{{ t('sidebar.fileTree.loading') }}</span>
        </div>
        <div
          v-else-if="dirState === 'error'"
          class="flex items-center gap-1.5 py-1 pr-2 font-mono text-[10.5px] text-danger"
          :style="childHintPaddingStyle"
          :data-testid="`file-tree-error-${node.path}`"
          @click="toggle"
        >
          <span :class="chevronSlotClass" data-testid="chevron-slot" />
          <AlertCircle class="size-3" />
          <span>{{ t('sidebar.fileTree.loadFailed') }}</span>
        </div>
        <template v-else>
          <FileTreeRow
            v-for="child in visibleChildren"
            :key="child.path"
            :node="child"
            :depth="depth + 1"
            :session-id="sessionId"
          />
          <!-- 已加载但空目录（按过滤后判定：全部 ignored 被过滤后也视为空） -->
          <div
            v-if="node.children && visibleChildren.length === 0"
            class="py-1 pr-2 font-mono text-[10.5px] text-subtle italic"
            :style="childHintPaddingStyle"
          >
            {{ t('sidebar.fileTree.emptyDir') }}
          </div>
        </template>
      </template>
    </template>

    <!-- 文件（v-else 紧邻上方目录 <template v-if>，绑定到 node.type 判断） -->
    <div
      v-else
      class="flex w-max min-w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-2 transition-colors hover:bg-surface-hover"
      :class="{ 'bg-accent-soft': isSelected }"
      :style="rowPaddingStyle"
      :data-testid="`file-tree-file-${node.path}`"
      @click="onSelectFile"
    >
      <!-- D-022：chevron 槽固定宽度占位，使文件 icon 与目录 folder icon 垂直对齐 -->
      <span :class="chevronSlotClass" data-testid="chevron-slot" />
      <component :is="fileIcon" class="size-3.5 shrink-0" :class="fileIconColor" />
      <span
        class="shrink whitespace-nowrap font-mono text-[12px]"
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
      <!-- W2 文件行数 +N −M（tracked 改动有 numstat；untracked 降级显 ~size） -->
      <span
        v-if="lineStats"
        class="shrink-0 font-mono text-[10px]"
        :data-testid="`file-tree-linestats-${node.path}`"
      >
        <span v-if="lineStats.add !== undefined" class="text-success">+{{ formatCount(lineStats.add) }}</span>
        <span v-if="lineStats.del !== undefined" class="text-danger">−{{ formatCount(lineStats.del) }}</span>
        <span v-if="lineStats.size !== undefined" class="text-subtle">~{{ formatCount(lineStats.size) }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, Folder, FileText, FileCode, FileJson, Loader2, AlertCircle } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { FileNode } from '@xyz-agent/shared'
import { useFileTreeStore } from '@/stores/fileTree'
import { useFileTree } from '@/composables/features/useFileTree'
import { useSideDrawer } from '@/composables/features/useSideDrawer'

const { t } = useI18n()

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

/** 缩进步进（px）：每层级增加的 padding-left，对齐 chevron 槽宽度（D-022） */
const INDENT_STEP = 14
/** 行 padding 基线（px）：depth=0 时的起始 padding-left（D-022） */
const BASE_PADDING = 8
/**
 * chevron 槽 Tailwind 类（D-022）：固定宽度 inline-flex 占位，目录放 ChevronRight、
 * 文件空占位，使目录 folder icon 与文件 file icon 垂直对齐。
 * 注意：宽度必须写死 14px 静态字符串，Tailwind JIT 不识别运行时拼接的任意值类。
 * 与 INDENT_STEP 保持同步（缩进单位 = chevron 槽宽度）。
 */
const chevronSlotClass = 'w-[14px] shrink-0 inline-flex items-center justify-center'

/**
 * 行 padding-left（D-022 单一公式）：目录行与文件行共用，不再用文件行 +10 数值补偿。
 * 每层缩进 INDENT_STEP px（视觉上一级缩进 ≈ 一个 chevron 位）。
 */
const rowPaddingStyle = computed(() => ({
  paddingLeft: `${props.depth * INDENT_STEP + BASE_PADDING}px`,
}))

/** 子层提示行（loading/error/空目录）padding：在当前 depth 基础上 +1 层缩进 */
const childHintPaddingStyle = computed(() => ({
  paddingLeft: `${(props.depth + 1) * INDENT_STEP + BASE_PADDING}px`,
}))

/** 展开态从 store 读（D-019 rehydrate：切回 session 自动恢复） */
const isExpanded = computed(() => store.getExpanded(props.sessionId).has(props.node.path))

/**
 * 渲染用子节点：showIgnored 关时递归剔除 ignored（与 FileView.visibleNodes 同策略）。
 * 后端始终返回 ignored 节点并标记，过滤纯前端完成，切换瞬时无闪烁。
 */
const visibleChildren = computed<FileNode[]>(() => {
  const children = props.node.children ?? []
  return store.showIgnored ? children : children.filter((c) => !c.ignored)
})

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
    case 'modified': return 'bg-warning-soft text-warning'
    case 'added': return 'bg-success-soft text-success'
    case 'deleted': return 'bg-danger-soft text-danger'
    case 'unmerged': return 'bg-danger-soft text-danger font-semibold'
    case 'renamed': return 'bg-info-soft text-info'
    case 'untracked': return 'bg-success-soft text-success'
    default: return ''
  }
})

/**
 * [W2] 目录改动数徽章：子树内改动文件数（store.getDirChangeCount）。
 * O(n) per 渲染，n=改动文件数（通常 <100），可接受。
 */
const dirChangeCount = computed(() => store.getDirChangeCount(props.sessionId, props.node.path))

/** [W2] 行数压缩阈值：≥此值显 9.9k（对齐 ProviderPage 上下文数压缩策略） */
const LINE_COUNT_COMPACT_THRESHOLD = 10000
/** [W2] 行数压缩除数（1000 → 显 k 后缀） */
const LINE_COUNT_COMPACT_DIVISOR = 1000

/** [W2] 文件行数结构：tracked 改动 {add/del}，untracked 降级 {size}，无数据 null */
interface LineStats { add?: number; del?: number; size?: number }

/**
 * [W2] 文件行数（从 gitOverlay 的 additions/deletions 取）。
 * - tracked 改动（modified/added/deleted/renamed）有 numstat → {add, del}
 * - untracked 无 numstat 但有 FileNode.size → {size}（降级显 ~size）
 * - unmerged/二进制/无标注 → null（不显）
 */
const lineStats = computed<LineStats | null>(() => {
  const git = store.getGitStatus(props.sessionId, props.node.path)
  if (!git) return null
  if (git.additions !== undefined || git.deletions !== undefined) {
    return { add: git.additions, del: git.deletions }
  }
  if (git.status === 'untracked' && props.node.size !== undefined) {
    return { size: props.node.size }
  }
  return null
})

/** [W2] 格式化行数/大小（≥阈值显 9.9k，否则原值） */
function formatCount(n: number): string {
  return n >= LINE_COUNT_COMPACT_THRESHOLD
    ? `${(n / LINE_COUNT_COMPACT_DIVISOR).toFixed(1)}k`
    : String(n)
}

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
