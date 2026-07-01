<template>
  <!--
    容器组件 · L1 Sidebar（sidebar/spec.md 四态）。
    分层（自上而下）：Brand → 主操作 nav（新建 ⌘N / 搜索 ⌘K）→ Overview 入口按钮 →
    segmented tab（会话|文件）→ 子视图区 → 用户区。
    折叠态 C：整体隐藏（width:0 + opacity:0），spec §收起态。
    File View 内容 G2-003 defer。
  -->
  <div
    class="sidebar h-full transition-[width,opacity] duration-[var(--duration-slow)] ease-[var(--ease)]"
    :class="{ 'w-0 opacity-0 overflow-hidden': sidebar.collapsed }"
  >
    <div class="sidebar__inner flex h-full w-[340px] flex-col pl-0.5">
      <!-- Brand -->
      <div class="flex items-center gap-2 px-2 pb-3.5 text-[13px] font-semibold">
        <span class="grid size-[22px] place-items-center rounded-md bg-accent text-[11px] font-bold text-white">x</span>
        <span class="text-fg">xyz-agent</span>
      </div>

      <!-- 主操作 nav：新建任务 ⌘N / 搜索 ⌘K -->
      <nav class="flex flex-col gap-px px-1">
        <Button
          variant="ghost"
          class="group h-auto justify-start gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
          @click="onNewSession"
        >
          <Plus class="size-[15px] text-subtle transition-colors group-hover:text-muted" />
          <span class="flex-1 text-left">新建任务</span>
          <kbd class="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">⌘ N</kbd>
        </Button>
        <Button
          variant="ghost"
          class="group h-auto justify-start gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
          @click="searchOpen = true"
        >
          <Search class="size-[15px] text-subtle transition-colors group-hover:text-muted" />
          <span class="flex-1 text-left">搜索</span>
          <kbd class="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">⌘ K</kbd>
        </Button>
      </nav>

      <div class="my-2 mx-2.5 h-px bg-border" />

      <!-- Overview 入口按钮（外部 L1 Region 入口，≠ segmented tab） -->
      <Button
        variant="ghost"
        :class="cn(
          'group mb-1 h-auto justify-start gap-2.5 rounded-md px-2 py-1.5 text-[12px]',
          isOverviewActive
            ? 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'
            : 'text-muted hover:bg-surface-hover hover:text-fg',
        )"
        @click="goOverview"
      >
        <LayoutGrid
          class="size-[15px] transition-colors"
          :class="isOverviewActive ? 'text-accent' : 'text-subtle group-hover:text-muted'"
        />
        <span class="flex-1 text-left">概览</span>
        <span
          v-if="session.list.length"
          class="font-mono text-[10px]"
          :class="isOverviewActive ? 'text-accent' : 'text-subtle'"
        >{{ session.list.length }}</span>
      </Button>

      <!-- segmented tab（会话 | 文件） -->
      <SegmentedTab
        v-model="sidebar.activeTab"
        :session-count="session.list.length"
        :file-count="fileCount"
      />

      <!-- 子视图区：会话列表（A）/ 文件视图（B，聚合 chat store fileChanges） -->
      <div class="mt-1 min-h-0 flex-1">
        <template v-if="sidebar.activeTab === 'sessions'">
          <SessionList
            :groups="session.groups"
            :active-id="session.activeId"
            :status-of="statusOf"
            @select="onSelectSession"
            @new-session="onNewSession"
            @rename="onRenameSession"
            @delete="onDeleteSession"
          />
        </template>
        <template v-else>
          <FileView
            v-if="session.activeId"
            :session-id="session.activeId"
            :session-label="currentSession?.label"
            :branch="currentSession?.gitBranch"
          />
          <!-- 无 active session（如 Overview 态）→ 文件视图空态占位 -->
          <div
            v-else
            class="flex flex-col items-center justify-center gap-2 py-10 text-center"
            data-testid="file-view-no-session"
          >
            <FolderOpen class="size-5 text-subtle opacity-40" />
            <p class="text-[11.5px] text-subtle opacity-55">选择会话查看文件</p>
          </div>
        </template>
      </div>

      <!-- 用户区（footer）· 齿轮图标打开 Settings（settings/spec.md §1） -->
      <div class="mt-auto flex items-center gap-2 rounded-md px-2 py-2 text-[12px] text-muted">
        <span class="size-5 shrink-0 rounded-full bg-gradient-to-br from-accent to-info" />
        <span class="flex-1 truncate text-fg">开发者</span>
        <button
          class="grid size-6 shrink-0 place-items-center rounded-sm text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
          title="设置"
          @click="openSettings()"
        >
          <Settings class="size-[14px]" />
        </button>
      </div>
    </div>

    <!-- 搜索浮层（⌘K 触发的全局 Overlay，spec §搜索浮层剥离） -->
    <SearchModal v-model:open="searchOpen" :active-session-id="session.activeId" />

    <RenameSessionDialog
      v-model:open="renameOpen"
      :session-id="targetSessionId"
      @confirm="onConfirmRename"
    />
    <DeleteSessionDialog
      v-model:open="deleteOpen"
      :session-id="targetSessionId"
      :session-label="targetSessionLabel"
      @confirm="onConfirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { Plus, LayoutGrid, Search, Settings, FolderOpen } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import SearchModal from '@/components/overlays/SearchModal.vue'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useSidebar } from '@/composables/features/useSidebar'
import SegmentedTab from './SegmentedTab.vue'
import SessionList from './SessionList.vue'
import FileView from './FileView.vue'
import RenameSessionDialog from './RenameSessionDialog.vue'
import DeleteSessionDialog from './DeleteSessionDialog.vue'
import { useFileTreeStore } from '@/stores/fileTree'

const navigation = useNavigationStore()
const session = useSessionStore()
const sidebar = useSidebarStore()
const fileTreeStore = useFileTreeStore()
const { selectSession, newSession, goOverview, loadSessions, derivedStatus, renameSession, deleteSession } = useSidebar()
const openSettings = inject<() => void>('openSettings', () => {})

/** 搜索浮层开关（⌘K / nav 搜索按钮触发，spec §搜索浮层） */
const searchOpen = ref(false)

/** Dialog 状态 */
const renameOpen = ref(false)
const deleteOpen = ref(false)
const targetSessionId = ref('')

const targetSessionLabel = computed(() =>
  session.list.find((s) => s.id === targetSessionId.value)?.label ?? '',
)

/** 当前是否处于 Overview view（按钮转 accent 态，spec §Overview 入口） */
const isOverviewActive = computed(() => navigation.current.view === 'overview')

/** 当前 active session（文件视图头部展示） */
const currentSession = computed(() => session.active)

/**
 * 文件 tab 计数（当前 session 文件树顶层节点数）。
 * W4 重写：文件视图从「改动文件列表」改为「完整文件树浏览器」，
 * 计数改为读 fileTreeStore 该 session 的顶层节点数（W4 UC-1 浏览完整结构）。
 */
const fileCount = computed(() => {
  const sid = session.activeId
  if (!sid) return 0
  return fileTreeStore.getTree(sid)?.length ?? 0
})

/** 状态点派生（D6）：useSidebar 读 chat+session store 派生 5 态 */
function statusOf(id: string) {
  return derivedStatus(id).value
}

async function onSelectSession(id: string): Promise<void> {
  await selectSession(id)
}

async function onNewSession(): Promise<void> {
  await newSession()
}

async function onRenameSession(id: string): Promise<void> {
  targetSessionId.value = id
  renameOpen.value = true
}

async function onDeleteSession(id: string): Promise<void> {
  targetSessionId.value = id
  deleteOpen.value = true
}

async function onConfirmRename(payload: { sessionId: string; label: string }): Promise<void> {
  await renameSession(payload.sessionId, payload.label)
}

async function onConfirmDelete(id: string): Promise<void> {
  await deleteSession(id)
}

/** 挂载时加载 session 列表（铁律 1：通过 features 层 loadSessions 调 api） */
onMounted(() => {
  void loadSessions()
})

/**
 * #10.1 AC-10.1：Sidebar 全局快捷键派发（消除硬编码 if/else，改 keymap 数组遍历匹配）。
 * - ⌘K toggle（AC-7.1 变更项：再按关闭，原 =true 改 !searchOpen）
 * - ⌘N 新建 session（shell spec §五）
 * - ⌘B 折叠侧栏（shell spec §⌘B；v1 只做 toggle 前两态，G-033 第 3 态 DEFERRED）
 *
 * [DEVIATED] AC-10.1 原文「改读 useCommandRegistry」未完全达成。现状（2026-07 修正后）：
 * commandStore.appCommands 已由 useSidebar.initApp → registerAppCommands 注册（新建任务/收起侧栏/概览），
 * 搜索浮层（⌘K）命令源聚合正常工作，点击命令能执行对应 action。
 * 但本地 keymap 仍保留，未完全切换为「读 useCommandRegistry 派发」：⌘K 不注册为 appCommand
 * （搜索结果里出现「搜索」命令是逻辑自指），完全通用化需独立 keymap 注册表 + shortcut DSL
 * （'mod+n'）+ 匹配引擎，属 D-019 标注的额外基础设施，超 P2 scope，登记 P3 后续迭代。
 */
interface KeymapEntry {
  key: string
  action: () => void
}
const keymap: KeymapEntry[] = [
  { key: 'k', action: () => { searchOpen.value = !searchOpen.value } },
  { key: 'n', action: () => { void newSession() } },
  { key: 'b', action: () => { sidebar.toggleCollapsed() } },
]
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  const hit = keymap.find((m) => m.key === e.key.toLowerCase())
  if (hit) {
    e.preventDefault()
    hit.action()
  }
})
</script>
