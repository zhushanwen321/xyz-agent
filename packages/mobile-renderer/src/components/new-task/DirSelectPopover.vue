<script setup lang="ts">
/**
 * DirSelectPopover.vue —— 步骤2 选目录 popover（spec §3.2 IA 重构后）。
 *
 * 纯文件系统导航：最近工作区 + 打开文件夹。
 * Worktree 相关内容（已有 worktree 列表 / 新建 worktree / 远程连接）已迁至 BranchSelectPopover 的
 * Worktree tab，本组件只保留目录选择职责。
 *
 * 形态：popover 内容面板（宽度 320px；向上展开由父级 PopoverContent side="top" 控制）。
 *
 * 数据流（container for data）：workspaceStore.records → RecentWorkspaceRecord[] top6。
 * 动作（presentational for actions，emit 单 payload 对象）：
 * - 选列表项 → emit('select', { cwd })（父接 useNewTaskFlow.selectWorkspace）
 * - 「打开文件夹」→ emit('open-dir-dialog')（父接 useNewTaskFlow.openDirDialog → OS 原生 dialog）
 * - Esc → emit('close')
 *
 * 空态（T3.2 / AC-5.4）：records=[] → 「暂无最近工作区 · 选择一个本地目录开始」。
 */
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, FolderPlus, Globe } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import { PopoverListItem, PopoverActionItem } from '@/components/ui/popover'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFlatListNav } from '@/composables/logic/useFlatListNav'
import { dirNameOf, parentDirNameOf } from '@/composables/logic/path'
import { isRemoteMode } from '@/lib/remote/connection-config'
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'

const props = defineProps<{
  /** 当前 cwd（高亮已选项，Card-Active） */
  currentCwd: string | null
}>()

const emit = defineEmits<{
  (e: 'select', payload: { cwd: string }): void
  (e: 'open-dir-dialog'): void
  (e: 'remote-connect'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()

const search = ref('')
const root = ref<HTMLElement | null>(null)

/** W1（MAX_RECORDS 10→6）：popover 列表展示上限，与 runtime RecentWorkspacesStore.MAX_RECORDS 对齐
 *  双保险：即便 runtime 返超量也只显 6 项 */
const MAX_DISPLAY = 6

/** 远程模式（一次性求值——modal reload 后整页重建，组件重挂时重新求值；不 watch）。
 *  远程模式：隐藏「打开文件夹」（远程无本地 OS dialog）+ 显「远程连接」+ 搜索框 Enter 支持手动路径。 */
const isRemote = isRemoteMode()

/** 尾部动作项数（远程模式=远程连接，本地模式=打开文件夹，互斥故恒 1） */
const ACTION_ITEM_COUNT = 1

/** W3: 改接 workspaceStore.records（取代旧 session.list 派生） */
const workspaces = computed<RecentWorkspaceRecord[]>(() => workspaceStore.records)

/** 搜索即时过滤（无 debounce，list < 50 本地缓存，spec §3.2） */
const filtered = computed<RecentWorkspaceRecord[]>(() => {
  const q = search.value.trim().toLowerCase()
  // W1（MAX_RECORDS 10→6）：双保险，即便 runtime 返超量也只显 6 项
  if (!q) return workspaces.value.slice(0, MAX_DISPLAY)
  // label 已是 cwd basename，是其全路径 cwd 的子串，单独按 cwd 匹配即可覆盖两者
  return workspaces.value.filter((w) => w.cwd.toLowerCase().includes(q)).slice(0, MAX_DISPLAY)
})

/** 空态：无最近工作区，或搜索无命中 */
const isEmpty = computed(() => filtered.value.length === 0)

/** 扁平化索引基准：recent 列表 + 动作项。DOM 顺序：recent items → open-dir */
const openDirIdx = computed(() => filtered.value.length)

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

function openRemoteConnect(): void {
  emit('remote-connect')
}

/**
 * 扁平化激活：列表项区间 → selectWorkspace，尾部动作项（idx === listLen）→ 按模式
 * 调 openFolder（本地）或 openRemoteConnect（远程）。
 */
function activate(idx: number): void {
  const listLen = filtered.value.length
  if (idx < listLen) {
    selectWorkspace(filtered.value[idx])
    return
  }
  // 动作项：本地=open-dir，远程=remote-connect（互斥，恒 1 项）
  if (isRemote) {
    openRemoteConnect()
  } else {
    openFolder()
  }
}

/**
 * 搜索框 Enter：远程模式 + filtered 无命中 → 把 search 当手动路径 emit('select')（R5 mitigation，
 * 避免新增第二个 Input；远程无本地 OS 文件夹可打开，手动路径是主入口）。
 * 远程模式 filtered 有命中 → 选中 filtered[0]（首条 record）。
 * 本地模式：return 不处理（让 Enter 冒泡到根 onKeydown 走原 useFlatListNav 激活 activeIndex）。
 *
 * 远程模式下 stopPropagation + preventDefault 防止冒泡到根 onKeydown 二次激活（重复 emit select）。
 */
function onSearchEnter(e: KeyboardEvent): void {
  if (!isRemote) return // 本地模式交给根 onKeydown 处理（保留原 Enter 导航行为）
  e.stopPropagation()
  e.preventDefault()
  if (filtered.value.length > 0) {
    selectWorkspace(filtered.value[0]!)
    return
  }
  const cwd = search.value.trim()
  if (cwd) {
    emit('select', { cwd })
  }
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
    class="w-[320px] max-h-[420px] overflow-hidden rounded-md border border-border-strong bg-bg-elevated shadow-2 outline-none"
    @keydown="onKeydown"
  >
    <!-- 搜索 input（sticky 顶部，spec §3.2）。
         远程模式：Enter 无 records 命中时把 search 当手动路径 emit('select')（IF5）。 -->
    <div class="border-b border-border p-2">
      <Input
        v-model="search"
        :placeholder="t('newTask.dirSelect.searchPlaceholder')"
        class="h-8 bg-surface-2 text-[13px]"
        @keydown.enter="onSearchEnter"
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

      <!-- 动作项：本地模式显「打开文件夹」（空态时即 Primary 入口，spec §6），
           远程模式隐藏（远程无本地 OS dialog 可触发） -->
      <PopoverActionItem
        v-if="!isRemote"
        test-id="action-open-dir"
        :active="isActiveItem(openDirIdx)"
        @click="openFolder"
        @mouseenter="activeIndex = openDirIdx"
      >
        <template #icon>
          <FolderPlus class="shrink-0 text-subtle" />
        </template>
        {{ t('newTask.dirSelect.openFolder') }}
      </PopoverActionItem>

      <!-- 动作项：远程模式显「远程连接」（spec §九:230-239），emit remote-connect 由 Landing 接打开 modal -->
      <PopoverActionItem
        v-else
        test-id="action-remote-connect"
        :active="isActiveItem(openDirIdx)"
        @click="openRemoteConnect"
        @mouseenter="activeIndex = openDirIdx"
      >
        <template #icon>
          <Globe class="shrink-0 text-subtle" />
        </template>
        {{ t('newTask.dirSelect.remoteConnect') }}
      </PopoverActionItem>
    </div>
  </div>
</template>
