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
      <!-- Brand（太极 logo + 产品名 + 版本号 + 升级指示器，v6 §6.2） -->
      <Brand :version-label="versionLabel">
        <template #trailing>
          <!-- 升级状态指示器（useAppUpdate 单例 state，idle/checking 不渲染） -->
          <UpdateButton class="ml-auto" />
        </template>
      </Brand>

      <!-- 主操作 nav：新建任务 ⌘N（primary 主操作）/ 搜索 ⌘K（ghost 次操作）。
           v6-master-spec §6.2 NavItem：primary=accent 实色 / ghost=透明 双层级。 -->
      <nav class="flex flex-col gap-px px-1">
        <Button
          variant="ghost"
          class="group h-8 w-full justify-start gap-2.5 rounded-md bg-accent px-3 text-[12px] font-medium text-accent-fg transition-colors hover:bg-accent-hover hover:text-accent-fg"
          @click="onNewSession"
        >
          <Plus class="size-[15px] text-accent-fg" />
          <span class="flex-1 text-left">{{ t('sidebar.newTask') }}</span>
          <kbd class="font-mono text-[10px] text-accent-fg opacity-70">{{ formatKbd('n') }}</kbd>
        </Button>
        <Button
          variant="ghost"
          class="group h-8 w-full justify-start gap-2.5 rounded-md px-3 text-[12px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
          @click="searchModal.open()"
        >
          <Search class="size-[15px] text-neutral-dim transition-colors group-hover:text-neutral-mid" />
          <span class="flex-1 text-left">{{ t('sidebar.search') }}</span>
          <kbd class="rounded-sm border border-border-strong px-1.5 py-0.5 font-mono text-[10px] text-neutral-dim">{{ formatKbd('k') }}</kbd>
        </Button>
      </nav>

      <div class="my-2 mx-2.5 h-px bg-border" />

      <!-- ProjectSwitcher（v6 D14：nav 下方 Project 一级导航，spec §6.2） -->
      <ProjectSwitcher />

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
      <div class="mt-1 min-h-0 flex-1 overflow-hidden">
        <template v-if="sidebar.activeTab === 'sessions'">
          <!-- S5：加载失败态 + 重试（session.listLoadError 非空时） -->
          <div
            v-if="session.listLoadError"
            class="flex flex-col items-center justify-center gap-2 py-10 text-center"
            data-testid="session-list-error"
          >
            <AlertCircle class="size-5 text-danger opacity-60" />
            <p class="text-[11px] text-neutral-mid">{{ t('sidebar.sessionListLoadFailed', { error: session.listLoadError }) }}</p>
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
            @delete-folder="onDeleteFolder"
            @stop-branch="onStopBranch"
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
          <!-- Transition: 列表 ↔ 详情切换的 slide 过渡（out-in 避免两个视图同时渲染）。
               Escape hatch：Transition 类无法用 Tailwind 表达，走 <style scoped>（design-system §3）。 -->
          <Transition name="wf-slide" mode="out-in">
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
          </Transition>
        </template>
        <!-- ExtensionHost sidebar view 宿主（audit §12.1 sidebar.tab 挂载点）。
             plugin 经 views.update 贡献 sidebar 视图 → ViewHostStore → ViewHost 渲染。
             empty="hidden"：无贡献时整组件零 DOM（不破坏布局）。sessionId 绑定焦点 session。
             见 02-extension-host-wiring.md 重构 2。 -->
        <template v-else-if="sidebar.activeTab === 'plugins'">
          <ViewHost
            v-if="focusedSessionId"
            view-id="sidebar.plugin"
            :session-id="focusedSessionId"
            empty="hidden"
          />
          <!-- 无焦点 session 时（Overview 态）空态占位，与 files tab 同范式 -->
          <div
            v-else
            class="flex flex-col items-center justify-center gap-2 py-10 text-center"
            data-testid="sidebar-plugin-no-session"
          >
            <Puzzle class="size-5 text-neutral-dim opacity-40" />
            <p class="text-[11px] text-neutral-dim opacity-55">{{ t('sidebar.selectSessionHint') }}</p>
          </div>
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
            <FolderOpen class="size-5 text-neutral-dim opacity-40" />
            <p class="text-[11px] text-neutral-dim opacity-55">{{ t('sidebar.selectSessionHint') }}</p>
          </div>
        </template>
      </div>

      <!-- 用户区（footer）· §6.2 UserArea：accent 纯色头像（去装饰渐变）+ 用户名 + 设置齿轮。 -->
      <div class="mt-auto flex items-center gap-2 rounded-md px-2 py-2 text-[12px] text-neutral-mid transition-colors hover:bg-surface-hover">
        <span class="size-5 shrink-0 rounded-full bg-accent" />
        <span class="flex-1 truncate text-neutral-fg">{{ t('sidebar.developer') }}</span>
        <Button
          variant="ghost"
          class="grid size-6 shrink-0 place-items-center rounded-sm p-0 text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[14px]"
          :title="t('sidebar.settingsTitle')"
          @click="openSettings()"
        >
          <Settings class="size-[14px]" />
        </Button>
      </div>
    </div>

    <!-- 搜索浮层（⌘K 触发的全局 Overlay，spec §搜索浮层剥离） -->
    <SearchModal
      v-model:open="isOpen"
      :active-session-id="focusedSessionId"
      :deps="searchDeps"
      :on-open-drawer="onOpenSearchDrawer"
      :on-toast-error="toastError"
    />

    <RenameSessionDialog
      v-model:open="renameOpen"
      :session-id="targetSessionId"
      @confirm="onConfirmRename"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { Plus, Search, Settings, FolderOpen, AlertCircle, Puzzle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { SearchModal } from '@xyz-agent/ui'
import { ViewHost } from '@xyz-agent/ui/extension-host'
import { useSearchModal } from '@xyz-agent/core'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'
import { useSessionDerivations } from '@/composables/features/chat/useSessionDerivations'
import SegmentedTab from './SegmentedTab.vue'
import SessionList from './SessionList.vue'
import UpdateButton from './UpdateButton.vue'
import Brand from './Brand.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'
import FileView from './FileView.vue'
import SubagentList from './SubagentList.vue'
import WorkflowList from './WorkflowList.vue'
import WorkflowDetail from './WorkflowDetail.vue'
import RenameSessionDialog from './RenameSessionDialog.vue'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useSubagentListSync } from '@/composables/features/chat/useSubagentListSync'
import { useWorkflowListSync } from '@/composables/features/chat/useWorkflowListSync'
import { useSidebarSubagentActions } from '@/composables/features/sidebar/useSidebarSubagentActions'
import { useGlobalShortcuts } from '@/composables/shell/useGlobalShortcuts'
import { useNavigationStore } from '@/stores/navigation'
import { useSidebarCounts } from '@/composables/features/sidebar/useSidebarCounts'
import { useSidebarSessionActions } from '@/composables/features/sidebar/useSidebarSessionActions'
import { useAppUpdate } from '@/composables/features/settings/useAppUpdate'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { usePlatformShortcut } from '@/composables/usePlatformShortcut'
import * as events from '@/api/events'

const { t } = useI18n()
const { formatKbd } = usePlatformShortcut()
const searchModal = useSearchModal()
const { isOpen } = searchModal
const session = useSessionStore()
const sidebar = useSidebarStore()
const subagentStore = useSubagentStore()
const workflowStore = useWorkflowStore()
const { error: toastError } = useToast()
const openSettings = inject<() => void>('openSettings', () => {})
const { selectSession, newSession, goOverview, loadSessions, renameSession, deleteSession, deleteFolder, focusedSessionId, focusedSession: currentSession, forkFromLastAssistant, enterForkModeFromLastAssistant, handoffFromLastAssistant } = useSidebarNew()
const piVersion = ref('')
const versionLabel = computed(() => piVersion.value ? `v${__APP_VERSION__} · pi v${piVersion.value}` : `v${__APP_VERSION__}`)
const renameOpen = ref(false)
const targetSessionId = ref('')
const { fileCount, subagentCount, subagentRunningCount, subagentList, workflowCount, workflowRunningCount, workflowList, currentWorkflow } = useSidebarCounts(focusedSessionId)
const { derivedStatus } = useSessionDerivations()
function statusOf(id: string) { return derivedStatus(id).value }
const { onSelectSession, onNewSession, onRenameSession, onDeleteSession, onDeleteFolder, onStopBranch, onConfirmRename, onRetryLoadSessions, onRetryWorkflows, onRetrySubagents, searchDeps, onOpenSearchDrawer } = useSidebarSessionActions({ focusedSessionId, selectSession, newSession, goOverview, loadSessions, renameSession, deleteSession, deleteFolder, renameOpen, targetSessionId })
const { onSelectSubagent, onCancelSubagent, onSelectWorkflow, onWorkflowBack, onSelectAgentCall, onWorkflowAction } = useSidebarSubagentActions(focusedSessionId)
useGlobalShortcuts({ onNewSession, forkFromLastAssistant, enterForkModeFromLastAssistant, handoffFromLastAssistant, navigation: useNavigationStore(), openSettings })
onMounted(() => {
  void loadSessions()
  events.onGlobalType('app.info', (msg) => { piVersion.value = msg.payload.piVersion })
  useSubagentListSync()
  useWorkflowListSync()
})
useAppUpdate().initAutoCheck() // setup 顶层同步调用（非 onMounted）：initAutoCheck 的 onScopeDispose 须在活跃 effect scope 内绑定
</script>

<style scoped>
/* Escape hatch（design-system §3）：Vue Transition 类无法用 Tailwind 表达，走 scoped style。
 * 列表 ↔ 详情切换：从右滑入/向右滑出，120ms fast（与 design-tokens --duration-fast 一致）。 */
.wf-slide-enter-active,
.wf-slide-leave-active {
  transition: transform var(--duration-fast) var(--ease), opacity var(--duration-fast) var(--ease);
}
.wf-slide-enter-from {
  transform: translateX(16px);
  opacity: 0;
}
.wf-slide-leave-to {
  transform: translateX(-16px);
  opacity: 0;
}
</style>
