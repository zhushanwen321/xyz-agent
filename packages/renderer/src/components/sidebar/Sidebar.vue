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
    <div class="sidebar__inner flex h-full w-[300px] flex-col pl-0.5">
      <!-- Brand -->
      <div class="flex items-center gap-2 px-2 pb-3.5">
        <span class="grid size-[22px] shrink-0 place-items-center rounded-md bg-accent text-[11px] font-bold text-fg">x</span>
        <div class="flex flex-col leading-tight">
          <span class="text-[13px] font-semibold text-fg">xyz-agent</span>
          <span class="text-[10px] text-muted">v{{ appVersion }}<template v-if="piVersion"> · pi v{{ piVersion }}</template></span>
        </div>
      </div>

      <!-- 主操作 nav：新建任务 ⌘N / 搜索 ⌘K -->
      <nav class="flex flex-col gap-px px-1">
        <Button
          variant="ghost"
          class="group h-auto justify-start gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
          @click="onNewSession"
        >
          <Plus class="size-[15px] text-subtle transition-colors group-hover:text-muted" />
          <span class="flex-1 text-left">{{ t('sidebar.newTask') }}</span>
          <kbd class="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">⌘ N</kbd>
        </Button>
        <Button
          variant="ghost"
          class="group h-auto justify-start gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
          @click="searchModal.open()"
        >
          <Search class="size-[15px] text-subtle transition-colors group-hover:text-muted" />
          <span class="flex-1 text-left">{{ t('sidebar.search') }}</span>
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
        <span class="flex-1 text-left">{{ t('sidebar.overview') }}</span>
        <span
          v-if="session.list.length"
          class="font-mono text-[10px]"
          :class="isOverviewActive ? 'text-accent' : 'text-subtle'"
        >{{ session.list.length }}</span>
      </Button>

      <!-- segmented tab（会话 | 文件 | Agents | Flows） -->
      <SegmentedTab
        v-model="sidebar.activeTab"
        :session-count="session.list.length"
        :file-count="fileCount"
        :subagent-count="subagentCount"
        :workflow-count="workflowCount"
        :subagent-running-count="subagentRunningCount"
        :workflow-running-count="workflowRunningCount"
      />

      <!-- 子视图区：会话列表 / 文件视图 / subagent 列表 -->
      <div class="mt-1 min-h-0 flex-1">
        <template v-if="sidebar.activeTab === 'sessions'">
          <!-- S5：加载失败态 + 重试（session.listLoadError 非空时） -->
          <div
            v-if="session.listLoadError"
            class="flex flex-col items-center justify-center gap-2 py-10 text-center"
            data-testid="session-list-error"
          >
            <AlertCircle class="size-5 text-danger opacity-60" />
            <p class="text-[11px] text-muted">{{ t('sidebar.sessionListLoadFailed', { error: session.listLoadError }) }}</p>
            <Button variant="ghost" class="h-6 text-[11px] text-accent" data-testid="session-list-retry" @click="onRetryLoadSessions">{{ t('sidebar.retry') }}</Button>
          </div>
          <SessionList
            v-else
            :groups="session.groups"
            :active-id="focusedSessionId"
            :status-of="statusOf"
            @select="onSelectSession"
            @new-session="onNewSession"
            @rename="onRenameSession"
            @delete="onDeleteSession"
          />
        </template>
        <template v-else-if="sidebar.activeTab === 'subagents'">
          <SubagentList
            :subagents="subagentList"
            :is-loading="subagentStore.isLoading"
            :load-error="subagentStore.loadError"
            @select="onSelectSubagent"
            @cancel="onCancelSubagent"
            @retry="onRetrySubagents"
          />
        </template>
        <template v-else-if="sidebar.activeTab === 'workflows'">
          <WorkflowDetail
            v-if="currentWorkflow"
            :workflow="currentWorkflow"
            @back="onWorkflowBack"
            @select-agent-call="onSelectAgentCall"
            @action="onWorkflowAction"
          />
          <WorkflowList
            v-else
            :workflows="workflowList"
            :is-loading="workflowStore.isLoading"
            :load-error="workflowStore.loadError"
            @select="onSelectWorkflow"
            @action="onWorkflowAction"
            @retry="onRetryWorkflows"
          />
        </template>
        <template v-else>
          <FileView
            v-if="focusedSessionId"
            :session-id="focusedSessionId"
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
            <p class="text-[11px] text-subtle opacity-55">{{ t('sidebar.selectSessionHint') }}</p>
          </div>
        </template>
      </div>

      <!-- 用户区（footer）· 齿轮图标打开 Settings（settings/spec.md §1） -->
      <div class="mt-auto flex items-center gap-2 rounded-md px-2 py-2 text-[12px] text-muted">
        <span class="size-5 shrink-0 rounded-full bg-gradient-to-br from-accent to-info" />
        <span class="flex-1 truncate text-fg">{{ t('sidebar.developer') }}</span>
        <Button
          variant="ghost"
          class="grid size-6 shrink-0 place-items-center rounded-sm text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
          :title="t('sidebar.settingsTitle')"
          @click="openSettings()"
        >
          <Settings class="size-[14px]" />
        </Button>
      </div>
    </div>

    <!-- 搜索浮层（⌘K 触发的全局 Overlay，spec §搜索浮层剥离） -->
    <SearchModal v-model:open="isOpen" :active-session-id="focusedSessionId" />

    <RenameSessionDialog
      v-model:open="renameOpen"
      :session-id="targetSessionId"
      @confirm="onConfirmRename"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { Plus, LayoutGrid, Search, Settings, FolderOpen, AlertCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import SearchModal from '@/components/overlays/SearchModal.vue'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useCommandStore } from '@/stores/command'
import { useSidebar } from '@/composables/features/useSidebar'
import { useSessionDerivations } from '@/composables/features/useSessionDerivations'
import SegmentedTab from './SegmentedTab.vue'
import SessionList from './SessionList.vue'
import FileView from './FileView.vue'
import SubagentList from './SubagentList.vue'
import WorkflowList from './WorkflowList.vue'
import WorkflowDetail from './WorkflowDetail.vue'
import RenameSessionDialog from './RenameSessionDialog.vue'
import { useFileTreeStore } from '@/stores/fileTree'
import { usePanelStore } from '@/stores/panel'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useSubagentListSync } from '@/composables/features/useSubagentListSync'
import { useWorkflowListSync } from '@/composables/features/useWorkflowListSync'
import { useSidebarSubagentActions } from '@/composables/features/useSidebarSubagentActions'
import { useSearchModal } from '@/composables/features/useSearchModal'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import * as events from '@/api/events'

const { t } = useI18n()
const searchModal = useSearchModal()
const { isOpen } = searchModal
const navigation = useNavigationStore()
const session = useSessionStore()
const { error: toastError } = useToast()
const sidebar = useSidebarStore()
const fileTreeStore = useFileTreeStore()
const panelStore = usePanelStore()
const subagentStore = useSubagentStore()
const workflowStore = useWorkflowStore()
const { selectSession, newSession, goOverview, loadSessions, renameSession, deleteSession, focusedSessionId, focusedSession } = useSidebar()
const { derivedStatus } = useSessionDerivations()
const openSettings = inject<() => void>('openSettings', () => {})

/** pi 版本号（runtime 启动时经 app.info 推送；xyz-agent 版本走构建时 __APP_VERSION__） */
const piVersion = ref('')
/** xyz-agent 版本（vite define 构建时注入，见 renderer/vite.config.ts） */
const appVersion = __APP_VERSION__

/** 搜索浮层开关（⌘K / nav 搜索按钮触发，spec §搜索浮层） */

/** Dialog 状态 */
const renameOpen = ref(false)
const targetSessionId = ref('')

/** 当前是否处于 Overview view（按钮转 accent 态，spec §Overview 入口） */
const isOverviewActive = computed(() => navigation.current.view === 'overview')

/** 当前焦点 session（文件视图头部展示，跟随 panel focus） */
const currentSession = focusedSession

/**
 * 文件 tab 计数（当前 session 文件树顶层节点数）。
 * W4 重写：文件视图从「改动文件列表」改为「完整文件树浏览器」，
 * 计数改为读 fileTreeStore 该 session 的顶层节点数（W4 UC-1 浏览完整结构）。
 */
const fileCount = computed(() => {
  const sid = focusedSessionId.value
  if (!sid) return 0
  return fileTreeStore.getTree(sid)?.length ?? 0
})

/** subagent tab 计数（当前 session 的 subagent 数量，读 store 共享列表） */
const subagentCount = computed(() => subagentStore.records.length)

/** subagent running 态数量（badge 精确化：仅 running>0 亮蓝点） */
const subagentRunningCount = computed(() => subagentStore.records.filter((r) => r.status === 'running').length)

/** subagent 列表（store records 的 computed 解包，供 template 直接用） */
const subagentList = computed(() => subagentStore.records)

/** workflow tab 计数（当前 session 的 workflow 数量，读 store 共享列表） */
const workflowCount = computed(() => workflowStore.workflowCount())

/** workflow running/paused 态数量（badge 精确化：仅活跃态>0 亮蓝点） */
const workflowRunningCount = computed(() => workflowStore.records.filter((r) => r.status === 'running' || r.status === 'paused').length)

/** workflow 列表（store records 的 computed 解包，供 template 直接用） */
const workflowList = computed(() => workflowStore.records)

/** 当前查看的 workflow record（视图 2 详情态，null 时显示视图 1 列表） */
const currentWorkflow = computed(() => workflowStore.getCurrentWorkflow(panelStore.activePanelId))

/** 状态点派生（D6）：useSessionDerivations 读 chat+session store 派生 5 态 */
function statusOf(id: string) {
  return derivedStatus(id).value
}

async function onSelectSession(id: string): Promise<void> {
  try {
    await selectSession(id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('sidebar.switchSessionFailed', { msg }))
  }
}

/** subagent/workflow 操作 handler（提取到 composable 减行） */
const {
  onSelectSubagent,
  onCancelSubagent,
  onSelectWorkflow,
  onWorkflowBack,
  onSelectAgentCall,
  onWorkflowAction,
} = useSidebarSubagentActions(focusedSessionId)

/** S5：重试加载会话列表（loadSessions 失败后用户点击重试） */
function onRetryLoadSessions(): void {
  void loadSessions()
}

/** M1：重试加载 workflow 列表 */
function onRetryWorkflows(): void {
  const sid = focusedSessionId.value
  if (sid) void workflowStore.loadWorkflows(sid)
}

/** M1：重试加载 subagent 列表 */
function onRetrySubagents(): void {
  const sid = focusedSessionId.value
  if (sid) void subagentStore.loadSubagents(sid)
}

async function onNewSession(): Promise<void> {
  try {
    await newSession()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('sidebar.newTaskFailed', { msg }))
  }
}

async function onRenameSession(id: string): Promise<void> {
  targetSessionId.value = id
  renameOpen.value = true
}

async function onDeleteSession(id: string): Promise<void> {
  try {
    await deleteSession(id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('sidebar.deleteSessionFailed', { msg }))
  }
}

async function onConfirmRename(payload: { sessionId: string; label: string }): Promise<void> {
  try {
    await renameSession(payload.sessionId, payload.label)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('sidebar.renameFailed', { msg }))
  }
}

/** 挂载时加载 session 列表（铁律 1：通过 features 层 loadSessions 调 api）+ 订阅 pi 版本
 *  + 启动 subagent 列表同步（watch 生命周期跟随 Sidebar 组件） */
onMounted(() => {
  void loadSessions()
  events.onGlobalType('app.info', (msg) => { piVersion.value = msg.payload.piVersion })
  useSubagentListSync()
  useWorkflowListSync()
})

/**
 * #10.1 AC-10.1：Sidebar 全局快捷键派发（消除硬编码 if/else，改 keymap 数组遍历匹配）。
 * - ⌘K toggle（AC-7.1 变更项：再按关闭，原 =true 改 !searchOpen）
 * - ⌘N 新建 session（shell spec §五）
 * - ⌘B 折叠侧栏（shell spec §⌘B；v1 只做 toggle 前两态，G-033 第 3 态 DEFERRED）
 *
 * ⌘K 不注册为 appCommand（搜索结果里出现「搜索」命令是逻辑自指），始终硬编码。
 * ⌘N/⌘B 支持用户自定义覆盖（commandStore.shortcutOverrides），SystemPage 设置页可重录。
 */
interface KeymapEntry {
  /** 默认 key（无 override 时用 ⌘+key 匹配） */
  key: string
  /** commandStore.shortcutOverrides 中的 id（有 override 时走 matchOverrideKey） */
  commandId?: string
  action: () => void
}
const commandStore = useCommandStore()
const keymap: KeymapEntry[] = [
  { key: 'k', action: () => { searchModal.toggle() } },
  { key: 'n', commandId: 'new-session', action: () => { void onNewSession() } },
  { key: 'b', commandId: 'toggle-sidebar', action: () => { sidebar.toggleCollapsed() } },
]
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  const overrides = commandStore.shortcutOverrides
  const hit = keymap.find((m) => {
    // 有 override → 解析组合键格式（'mod+n' / 'shift+j' / 'j'）
    if (m.commandId && overrides[m.commandId]) {
      return matchOverrideKey(e, overrides[m.commandId])
    }
    // 默认：⌘/Ctrl + key
    const mod = e.metaKey || e.ctrlKey
    return mod && e.key.toLowerCase() === m.key
  })
  if (hit) {
    e.preventDefault()
    hit.action()
  }
})

/** 匹配自定义快捷键格式（'mod+n' / 'shift+j' / 'j' / 'alt+x' 等） */
function matchOverrideKey(e: KeyboardEvent, override: string): boolean {
  const parts = override.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needMod = parts.includes('mod')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')
  if (needMod && !(e.metaKey || e.ctrlKey)) return false
  if (needShift && !e.shiftKey) return false
  if (needAlt && !e.altKey) return false
  return e.key.toLowerCase() === key
}
</script>
