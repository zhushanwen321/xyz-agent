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
    <div class="sidebar__inner flex h-full w-[200px] flex-col pl-0.5">
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
        :file-count="0"
      />

      <!-- 子视图区：会话列表（A）/ 文件视图（B，内容 G2-003 defer） -->
      <div class="mt-1 min-h-0 flex-1">
        <template v-if="sidebar.activeTab === 'sessions'">
          <SessionList
            :sessions="session.list"
            :active-id="session.activeId"
            :status-of="statusOf"
            @select="onSelectSession"
            @new-session="onNewSession"
          />
        </template>
        <template v-else>
          <div class="flex h-full items-center justify-center px-4 text-center text-[11px] text-subtle opacity-60">
            文件视图待联调<br><span class="font-mono text-[10px]">（G2-003 deferred）</span>
          </div>
        </template>
      </div>

      <!-- 用户区（footer） -->
      <div class="mt-auto pt-1.5">
        <div class="flex items-center gap-2 rounded-md px-2 py-2 text-[12px] text-muted transition-colors hover:bg-surface-hover">
          <span class="size-5 shrink-0 rounded-full bg-gradient-to-br from-accent to-info" />
          <span class="truncate text-fg">开发者</span>
        </div>
      </div>
    </div>

    <!-- 搜索浮层（⌘K 触发的全局 Overlay，spec §搜索浮层剥离） -->
    <SearchModal v-model:open="searchOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { Plus, LayoutGrid, Search } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import SearchModal from '@/components/overlays/SearchModal.vue'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'
import { useSidebarStore } from '@/stores/sidebar'
import { useSidebar } from '@/composables/features/useSidebar'
import SegmentedTab from './SegmentedTab.vue'
import SessionList from './SessionList.vue'

const navigation = useNavigationStore()
const session = useSessionStore()
const sidebar = useSidebarStore()
const { selectSession, newSession, goOverview, loadSessions, derivedStatus } = useSidebar()

/** 搜索浮层开关（⌘K / nav 搜索按钮触发，spec §搜索浮层） */
const searchOpen = ref(false)

/** 当前是否处于 Overview view（按钮转 accent 态，spec §Overview 入口） */
const isOverviewActive = computed(() => navigation.current.view === 'overview')

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

/** 挂载时加载 session 列表（铁律 1：通过 features 层 loadSessions 调 api） */
onMounted(() => {
  void loadSessions()
})

/** ⌘N 新建 session + ⌘B 折叠侧栏（shell spec §五/§⌘B 三态；v1 只做 toggle 前两态，G-033 第 3 态 DEFERRED） */
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault()
    void newSession()
  } else if (e.key === 'k' || e.key === 'K') {
    e.preventDefault()
    searchOpen.value = true
  } else if (e.key === 'b' || e.key === 'B') {
    e.preventDefault()
    sidebar.toggleCollapsed()
  }
})
</script>
