<script setup lang="ts">
/**
 * DirSelectPopover.vue —— 步骤2 选目录 popover（#5，spec §3.2）。
 *
 * 形态：popover 内容面板（锚定 + 宽度由本组件定 380px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data）：workspaceStore.records → RecentWorkspaceRecord[] top10。
 * 动作（presentational for actions，emit 单 payload 对象）：
 * - 选列表项 → emit('select', { cwd })（父接 useNewTaskFlow.selectWorkspace）
 * - 「打开文件夹」→ emit('open-dir-dialog')（父接 useNewTaskFlow.openDirDialog → OS 原生 dialog）
 * - 「远程连接」→ v1 stub toast「v1 暂未支持」（spec §6 / issues #11 P3 延后）
 * - Esc → emit('close')
 *
 * 空态（T3.2 / AC-5.4）：records=[] → 「暂无最近工作区 · 选择一个本地目录开始」。
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, FolderPlus, Cloud } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { PopoverListItem, PopoverActionItem } from '@/components/ui/popover'
import { useWorkspaceStore } from '@/stores/workspace'
import { useToast } from '@/composables/useToast'
import { useFlatListNav } from '@/composables/logic/useFlatListNav'
import { dirNameOf, parentDirNameOf } from '@/composables/logic/path'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'

const props = defineProps<{
  /** 当前 cwd（高亮已选项，Card-Active） */
  currentCwd: string | null
}>()

const emit = defineEmits<{
  (e: 'select', payload: { cwd: string }): void
  (e: 'open-dir-dialog'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const { error: toastError } = useToast()

/** spec §6：远程连接 v1 stub（issues #11 P3），点开 toast 提示 */
// v1 暂未支持远程连接（i18n key: newTask.dirSelect.remoteNotSupported）
/** 扁平化键盘导航的尾部动作项数（打开文件夹 + 远程连接） */
const ACTION_ITEM_COUNT = 2

const search = ref('')
const root = ref<HTMLElement | null>(null)

/** W3: 改接 workspaceStore.records（取代旧 session.list 派生） */
const workspaces = computed<RecentWorkspaceRecord[]>(() => workspaceStore.records)

/** 搜索即时过滤（无 debounce，list < 50 本地缓存，spec §3.2） */
const filtered = computed<RecentWorkspaceRecord[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return workspaces.value
  // label 已是 cwd basename，是其全路径 cwd 的子串，单独按 cwd 匹配即可覆盖两者
  return workspaces.value.filter((w) => w.cwd.toLowerCase().includes(q))
})

/** 空态：无最近工作区，或搜索无命中 */
const isEmpty = computed(() => filtered.value.length === 0)

/** basename 出现该次数即视为同名，需追加上级段名消歧 */
const DUP_THRESHOLD = 2

/**
 * 当前可见列表内重复 ≥ DUP_THRESHOLD 次的 basename 集合——这些目录需追加上级段名消歧
 * （如 /Code/chat_project 与 /Stock/chat_project → 都显 chat_project(Code)/chat_project(Stock)）。
 * 以 filtered（搜索后实际展示的列表）为统计范围，让搜索缩小范围后也能正确消歧。
 */
const dupBasenames = computed<Set<string>>(() => {
  const counts = new Map<string, number>()
  for (const w of filtered.value) {
    const b = dirNameOf(w.cwd)
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, n]) => n >= DUP_THRESHOLD).map(([b]) => b))
})

/** 列表项显示文案：默认 basename，同名时追加 (parent) 消歧 */
function displayLabel(ws: RecentWorkspaceRecord): string {
  const base = dirNameOf(ws.cwd)
  if (!dupBasenames.value.has(base)) return base
  const parent = parentDirNameOf(ws.cwd)
  return parent ? `${base}(${parent})` : base
}

onMounted(() => {
  // 打开即 focus 搜索框（spec §3.2 键盘契约）
  nextTick(() => root.value?.querySelector('input')?.focus())
})

function selectWorkspace(ws: RecentWorkspaceRecord): void {
  emit('select', { cwd: ws.cwd })
}

function openFolder(): void {
  emit('open-dir-dialog')
}

function remoteStub(): void {
  toastError(t('newTask.dirSelect.remoteNotSupported'))
}

/** 扁平化激活：列表项区间 → selectWorkspace，尾部动作项 → openFolder / remoteStub */
function activate(idx: number): void {
  const listLen = filtered.value.length
  if (idx < listLen) selectWorkspace(filtered.value[idx])
  else if (idx === listLen) openFolder()
  else remoteStub()
}

// 键盘导航收敛到 logic/useFlatListNav（与 BranchSelectPopover 共用）。
const { activeIndex, onKeydown, isActiveItem } = useFlatListNav({
  getTotal: () => filtered.value.length + ACTION_ITEM_COUNT,
  onActivate: activate,
  onEscape: () => emit('close'),
})
</script>

<template>
  <div
    ref="root"
    data-testid="dir-select-popover"
    class="w-[380px] max-h-[420px] overflow-hidden rounded-md border border-border-strong bg-bg-elevated shadow-2 outline-none"
    @keydown="onKeydown"
  >
    <!-- 搜索 input（sticky 顶部，spec §3.2） -->
    <div class="border-b border-border p-2">
      <Input
        v-model="search"
        :placeholder="t('newTask.dirSelect.searchPlaceholder')"
        class="h-8 bg-surface-2 text-[13px]"
      />
    </div>

    <div class="max-h-[360px] overflow-y-auto py-1">
      <!-- 空态（T3.2 / AC-5.4，spec §6 三要素：subtle 图标 + 说明 + Primary 入口在下方动作项） -->
      <div
        v-if="isEmpty"
        data-testid="empty-state"
        class="flex flex-col items-center gap-2 px-4 py-6 text-center"
      >
        <Folder class="size-5 text-subtle" />
        <p class="text-[12px] text-muted">{{ t('newTask.dirSelect.noRecent') }}</p>
      </div>

      <!-- 列表项（非空态）：默认只显目录名，同名时追加 (parent) 消歧 -->
      <PopoverListItem
        v-for="(ws, i) in filtered"
        :key="ws.cwd"
        test-id="workspace-item"
        :active="isActiveItem(i)"
        :selected="ws.cwd === props.currentCwd"
        @click="selectWorkspace(ws)"
        @mouseenter="activeIndex = i"
      >
        <template #icon>
          <Folder class="shrink-0 text-subtle" />
        </template>
        <span class="flex min-w-0 flex-1 flex-col items-start">
          <span class="truncate text-fg">{{ displayLabel(ws) }}</span>
        </span>
      </PopoverListItem>

      <!-- 分隔线 -->
      <div class="my-1 h-px bg-border" />

      <!-- 动作项：打开文件夹（空态时即 Primary 入口，spec §6） -->
      <PopoverActionItem
        test-id="action-open-dir"
        :active="isActiveItem(filtered.length)"
        @click="openFolder"
        @mouseenter="activeIndex = filtered.length"
      >
        <template #icon>
          <FolderPlus class="shrink-0 text-subtle" />
        </template>
        {{ t('newTask.dirSelect.openFolder') }}
      </PopoverActionItem>

      <!-- 动作项：远程连接（v1 stub） -->
      <PopoverActionItem
        test-id="action-remote"
        :active="isActiveItem(filtered.length + 1)"
        @click="remoteStub"
        @mouseenter="activeIndex = filtered.length + 1"
      >
        <template #icon>
          <Cloud class="shrink-0 text-subtle" />
        </template>
        {{ t('newTask.dirSelect.remoteConnect') }}
      </PopoverActionItem>
    </div>
  </div>
</template>
