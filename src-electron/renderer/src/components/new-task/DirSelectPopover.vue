<script setup lang="ts">
/**
 * DirSelectPopover.vue —— 步骤2 选目录 popover（#5，spec §3.2）。
 *
 * 形态：popover 内容面板（锚定 + 宽度由本组件定 380px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data）：useSessionStore().list → recentWorkspaces → RecentWorkspace[] top10。
 * 动作（presentational for actions，emit 单 payload 对象）：
 * - 选列表项 → emit('select', { cwd })（父接 useNewTaskFlow.selectWorkspace）
 * - 「打开文件夹」→ emit('open-dir-dialog')（父接 useNewTaskFlow.openDirDialog → OS 原生 dialog）
 * - 「远程连接」→ v1 stub toast「v1 暂未支持」（spec §6 / issues #11 P3 延后）
 * - Esc → emit('close')
 *
 * 空态（T3.2 / AC-5.4）：recentWorkspaces=[] → 「暂无最近工作区 · 选择一个本地目录开始」。
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { Folder, FolderPlus, Cloud, Check } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/stores/session'
import { recentWorkspaces } from '@/lib/utils'
import { useToast } from '@/composables/useToast'
import type { RecentWorkspace } from '@/lib/utils'

const props = defineProps<{
  /** 当前 cwd（高亮已选项，Card-Active） */
  currentCwd: string | null
}>()

const emit = defineEmits<{
  (e: 'select', payload: { cwd: string }): void
  (e: 'open-dir-dialog'): void
  (e: 'close'): void
}>()

const session = useSessionStore()
const { error: toastError } = useToast()

/** spec §6：远程连接 v1 stub（issues #11 P3），点开 toast 提示 */
const REMOTE_UNSUPPORTED_MSG = 'v1 暂未支持远程连接'
/** 扁平化键盘导航的尾部动作项数（打开文件夹 + 远程连接） */
const ACTION_ITEM_COUNT = 2

const search = ref('')
const root = ref<HTMLElement | null>(null)
/** 键盘焦点索引（跨组扁平化：列表项 + 动作项） */
const activeIndex = ref(0)

const workspaces = computed<RecentWorkspace[]>(() => recentWorkspaces(session.list))

/** 搜索即时过滤（无 debounce，list < 50 本地缓存，spec §3.2） */
const filtered = computed<RecentWorkspace[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return workspaces.value
  // label 已是 cwd basename，是其全路径 cwd 的子串，单独按 cwd 匹配即可覆盖两者
  return workspaces.value.filter((w) => w.cwd.toLowerCase().includes(q))
})

/** 空态：无最近工作区，或搜索无命中 */
const isEmpty = computed(() => filtered.value.length === 0)

onMounted(() => {
  // 打开即 focus 搜索框（spec §3.2 键盘契约）
  nextTick(() => root.value?.querySelector('input')?.focus())
})

function isActiveItem(idx: number): boolean {
  return idx === activeIndex.value
}

function selectWorkspace(ws: RecentWorkspace): void {
  emit('select', { cwd: ws.cwd })
}

function openFolder(): void {
  emit('open-dir-dialog')
}

function remoteStub(): void {
  toastError(REMOTE_UNSUPPORTED_MSG)
}

function onKeydown(e: KeyboardEvent): void {
  // 扁平化可选集：filtered 列表 + 动作项（spec §3.2 ↑↓ 跨组扁平化）
  const total = filtered.value.length + ACTION_ITEM_COUNT
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % total
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + total) % total
  } else if (e.key === 'Enter') {
    e.preventDefault()
    activate(activeIndex.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function activate(idx: number): void {
  const listLen = filtered.value.length
  if (idx < listLen) selectWorkspace(filtered.value[idx])
  else if (idx === listLen) openFolder()
  else remoteStub()
}
</script>

<template>
  <div
    ref="root"
    data-testid="dir-select-popover"
    class="w-[380px] overflow-hidden rounded-md border border-border-strong bg-bg-elevated shadow-2 outline-none"
    @keydown="onKeydown"
  >
    <!-- 搜索 input（sticky 顶部，spec §3.2） -->
    <div class="border-b border-border p-2">
      <Input
        v-model="search"
        placeholder="搜索工作区"
        class="h-8 bg-surface-2 text-[13px]"
      />
    </div>

    <div class="py-1">
      <!-- 空态（T3.2 / AC-5.4，spec §6 三要素：subtle 图标 + 说明 + Primary 入口在下方动作项） -->
      <div
        v-if="isEmpty"
        data-testid="empty-state"
        class="flex flex-col items-center gap-2 px-4 py-6 text-center"
      >
        <Folder class="size-5 text-subtle" />
        <p class="text-[12.5px] text-muted">暂无最近工作区 · 选择一个本地目录开始</p>
      </div>

      <!-- 列表项（非空态） -->
      <Button
        v-for="(ws, i) in filtered"
        :key="ws.cwd"
        data-testid="workspace-item"
        :data-active="ws.cwd === props.currentCwd"
        variant="ghost"
        class="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-[13px] text-fg hover:bg-surface-hover [&_svg]:size-4"
        :class="[
          ws.cwd === props.currentCwd ? 'bg-surface-2 ring-1 ring-inset ring-accent-ring' : '',
          isActiveItem(i) ? 'bg-surface-hover' : '',
        ]"
        @click="selectWorkspace(ws)"
        @mouseenter="activeIndex = i"
      >
        <Folder class="shrink-0 text-subtle" />
        <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span class="truncate text-fg">{{ ws.label }}</span>
          <span class="truncate font-mono text-[11px] text-subtle">{{ ws.cwd }}</span>
        </span>
        <Check
          v-if="ws.cwd === props.currentCwd"
          class="size-4 shrink-0 text-accent"
        />
      </Button>

      <!-- 分隔线 -->
      <div class="my-1 h-px bg-border" />

      <!-- 动作项：打开文件夹（空态时即 Primary 入口，spec §6） -->
      <Button
        data-testid="action-open-dir"
        variant="ghost"
        class="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-[13px] text-fg hover:bg-surface-hover [&_svg]:size-4"
        :class="isActiveItem(filtered.length) ? 'bg-surface-hover' : ''"
        @click="openFolder"
        @mouseenter="activeIndex = filtered.length"
      >
        <FolderPlus class="shrink-0 text-subtle" />
        <span>打开文件夹</span>
      </Button>

      <!-- 动作项：远程连接（v1 stub） -->
      <Button
        data-testid="action-remote"
        variant="ghost"
        class="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-[13px] text-fg hover:bg-surface-hover [&_svg]:size-4"
        :class="isActiveItem(filtered.length + 1) ? 'bg-surface-hover' : ''"
        @click="remoteStub"
        @mouseenter="activeIndex = filtered.length + 1"
      >
        <Cloud class="shrink-0 text-subtle" />
        <span>远程连接</span>
      </Button>
    </div>
  </div>
</template>
