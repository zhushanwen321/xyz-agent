<template>
  <!--
    展示组件 · panel-header（panel/spec.md zone ①，draft-dual-panel header 结构）。
    布局：状态点 + breadcrumb（项目▸会话▸分支，shell/spec §四）+ ... + [split|新建会话] + 更多 + 关闭。
    breadcrumb 三段：项目名（cwd 末段）▸ 会话名 ▸ 分支名（mono+accent）。
    popover 点击跳转 DEFERRED（shell/spec §八，属 G3 联调）；v1 纯展示。
    状态点 per-session；split/新建会话同槽位互斥（单显 split，双显新建会话）。
    split 单 session 场景（G-023）/ close 确认流（G-013）DEFERRED：v1 渲染按钮但 split 触发结构切换，
    close 双→单可用；更多菜单（G2-005 rename 等）DEFERRED hide。
    拖拽区（shell/spec §七-6）：header 空白 -webkit-app-region:drag，交互元素 no-drag。
    折叠态 chrome 落位（sidebar/spec.md §收起态 + draft-collapsed-state.html 卡 A/B/C）：
    sidebar 折叠 && P1 时，收起/←/→ 三按钮迁入此 header 最左侧（chrome 槽位）。
    安全区 padding：非全屏留 pl-[88px] 让位窗口左上 traffic-light（红黄绿 x16~68，header 内容从 x12+88=100 起，
    chrome 按钮与红黄绿拉开 32px 呼吸）；全屏态红黄绿 OS 隐藏，header pl-4（卡 B「h-nav 紧贴左」）。
    仅 P1 承载（window-level chrome 属一个地方）；P2 header 不变。唤回侧栏靠 ⌘B + 此 chrome 按钮（rail-restore 已移除）。
  -->
  <header
    class="flex h-[38px] flex-shrink-0 items-center gap-2 border-b border-border px-3.5 [-webkit-app-region:drag]"
    :class="showChrome && !isFullscreen ? 'pl-[88px]' : 'pl-4'"
  >
    <!-- 折叠态 P1 chrome 槽位：收起/←/→ 三按钮（sidebar/spec §收起态「导航能力迁移」）。
         整组 no-drag（修折叠态浮层按钮被 drag 区拦截的 bug）；flex-shrink:0 让 breadcrumb 自动右移。 -->
    <div
      v-if="showChrome"
      class="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
    >
      <Button
        variant="ghost"
        size="icon"
        class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg"
        :title="sidebar.collapsed ? t('panel.header.toggleSidebarExpand') : t('panel.header.toggleSidebarCollapse')"
        :aria-label="t('panel.header.toggleSidebarAria')"
        @click="sidebar.toggleCollapsed()"
      >
        <PanelLeftOpen v-if="sidebar.collapsed" class="size-[14px]" />
        <PanelLeftClose v-else class="size-[14px]" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle"
        :disabled="!navigation.canBack"
        :title="t('panel.header.back')"
        :aria-label="t('panel.header.back')"
        @click="navigation.back()"
      >
        <ArrowLeft class="size-[14px]" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="nav-btn h-[22px] w-[26px] rounded-md text-subtle hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle"
        :disabled="!navigation.canForward"
        :title="t('panel.header.forward')"
        :aria-label="t('panel.header.forward')"
        @click="navigation.forward()"
      >
        <ArrowRight class="size-[14px]" />
      </Button>
    </div>
    <!-- subagent 视图返回按钮：viewingSubagent 态显示，替代正常态的 spinner+breadcrumb。
         右侧按钮组（drawer/git/split/close）不受影响，继续保留。 -->
    <Button
      v-if="viewingSubagent"
      variant="ghost"
      size="icon"
      class="shrink-0 gap-1 rounded-md text-muted hover:bg-surface-hover hover:text-fg [-webkit-app-region:no-drag]"
      :title="t('panel.header.backToMain')"
      data-testid="subagent-back-btn"
      @click="emit('back')"
    >
      <ArrowLeft class="size-[14px]" />
    </Button>
    <span
      v-if="viewingSubagent"
      class="min-w-0 shrink truncate text-[12.5px] font-medium text-fg"
      :title="subagentLabel"
    >{{ subagentLabel }}</span>
    <component
      :is="ICON_COMPONENTS[iconConfig.icon]"
      v-if="!viewingSubagent"
      data-testid="panel-session-icon"
      :data-icon="iconConfig.icon"
      class="size-[13px] shrink-0"
      :class="[iconConfig.color, iconConfig.animation]"
    />
    <span
      v-if="false"
      data-testid="panel-session-dot"
      class="size-[7px] shrink-0 rounded-full"
      :class="statusDotClass"
    />
    <!-- breadcrumb（shell/spec §四：项目 ▸ 分支，落点在 main-header 内）。
         不显会话名（仅目录 + 分支两段），避免与目录视觉重复。
         shrink + min-w-0：长目录+分支时截断优先发生于此，绝不盖右侧 3 按钮（按钮组 ml-auto + shrink-0）。 -->
    <nav v-if="!viewingSubagent" class="flex min-w-0 shrink items-center gap-1 [-webkit-app-region:no-drag]">
      <ol class="flex min-w-0 items-center gap-1 text-[12.5px]">
        <li class="flex min-w-0 items-center gap-1.5">
          <Folder class="size-3 shrink-0 opacity-70 text-subtle" />
          <span
            class="truncate font-mono text-[12px] font-semibold"
            :class="active ? 'text-fg' : 'text-muted'"
            :title="`${t('panel.header.workingDir')}：${sessionDir}`"
          >{{ dirName }}</span>
        </li>
        <template v-if="gitBranch">
          <li aria-hidden="true" class="text-subtle opacity-50">
            <ChevronRight class="size-3 shrink-0" />
          </li>
          <li class="min-w-0">
            <span
              class="truncate font-mono text-[11px] text-accent"
              :title="`${t('panel.header.branch')}：${gitBranch}`"
            >{{ gitBranch }}</span>
          </li>
        </template>
      </ol>
    </nav>

    <div class="ml-auto flex items-center gap-0.5 [-webkit-app-region:no-drag]">
      <!-- SideDrawer toggle（always-visible，不依赖 git 仓库）。
           非折叠态显此按钮；折叠态 chrome 按钮组已含侧栏切换。 -->
      <Button
        v-if="!showChrome"
        variant="ghost"
        size="icon"
        class="size-[26px] rounded-md text-muted hover:bg-surface-hover hover:text-fg [-webkit-app-region:no-drag]"
        data-testid="drawer-toggle"
        :title="t('panel.sideDrawer.title')"
        @click="emit('toggleDrawer')"
      >
        <PanelRight class="size-[15px]" />
      </Button>
      <!-- git 入口（panel/spec.md：git 移入 SideDrawer git tab）。
           非 git 仓库不渲染（gitIndicator.hasRepo=false）。脏状态点：
           conflict → danger；有改动（staged/dirty）→ warning；clean → 无点。
           与 breadcrumb 分支名同语义聚合（per-session header 承载 git 入口）。 -->
      <Button
        v-if="gitIndicator?.hasRepo"
        variant="ghost"
        size="icon"
        class="relative size-[26px] rounded-md text-muted hover:bg-surface-hover hover:text-fg [-webkit-app-region:no-drag]"
        :title="t('panel.header.gitStatus')"
        @click="emit('openGit')"
      >
        <GitBranch class="size-[15px]" />
        <span
          v-if="gitIndicator.hasChanges"
          class="absolute right-1 top-1 size-1.5 rounded-full"
          :class="gitIndicator.conflict ? 'bg-danger' : 'bg-warning'"
          aria-hidden="true"
        />
      </Button>
      <!-- split/新建会话 同槽位互斥（panel/spec.md 状态与交互）：
           单 panel 显「分屏」（开第二会话）；双 panel 显「新建会话」（替换待机侧为新 session 并聚焦） -->
      <Button
        v-if="!isDual"
        variant="ghost"
        size="icon"
        class="size-[26px] rounded-md text-muted hover:bg-surface-hover hover:text-fg [-webkit-app-region:no-drag]"
        :title="t('panel.header.split')"
        @click="emit('split')"
      >
        <Columns2 class="size-[15px]" />
      </Button>
      <Button
        v-else
        variant="ghost"
        size="icon"
        class="size-[26px] rounded-md text-muted hover:bg-surface-hover hover:text-fg [-webkit-app-region:no-drag]"
        :title="t('panel.header.newSession')"
        @click="emit('newSession')"
      >
        <Plus class="size-[15px]" />
      </Button>
      <!-- 关闭（×）：独立按钮（与 split 槽位分离）。双 panel → 关闭该侧回单；
           单 panel 关闭确认流 G-013 DEFERRED，v1 不显。
           三点更多 ⋯（G2-005 rename 等）全 DEFERRED，按 G3-002 hide 规则不显示 -->
      <Button
        v-if="isDual"
        variant="ghost"
        size="icon"
        class="size-[26px] rounded-md text-muted hover:bg-[rgba(239,68,68,0.12)] hover:text-danger [-webkit-app-region:no-drag]"
        :title="t('panel.header.closeSession')"
        @click="emit('close')"
      >
        <X class="size-[15px]" />
      </Button>
    </div>
  </header>
</template>

<script setup lang="ts">
 
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, Columns2, X, ChevronRight, Plus, GitBranch, PanelLeftOpen, PanelLeftClose, PanelRight, ArrowLeft, ArrowRight, RefreshCw, ArrowUpCircle, Hourglass, Wrench, Zap, CheckCircle2, Ban, AlertCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useNavigationStore } from '@/stores/navigation'
import { useSidebarStore } from '@/stores/sidebar'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import type { DerivedStatus } from '@/types'
import type { GitIndicator } from '@/composables/features/useGitStatus'
import { DOT_CLASS, STATUS_ICON } from '@/composables/logic/sessionStatus'

const props = defineProps<{
  sessionLabel: string
  sessionDir: string
  gitBranch?: string
  /** git 脏状态指示（驱动右侧 git 图标按钮显隐 + 脏状态点色）。hasRepo=false 不渲染按钮 */
  gitIndicator?: GitIndicator
  status: DerivedStatus
  active: boolean
  isDual: boolean
  /** 是否为 P1（panel.panels[0]）—— 折叠态 chrome 仅落 P1 header */
  isFirstPanel: boolean
  /** 是否在查看 subagent 对话流（显示返回按钮，隐藏正常态内容） */
  viewingSubagent?: boolean
  /** subagent 视图标题（agent 名称 + subagentId 摘要） */
  subagentLabel?: string
}>()

const emit = defineEmits<{
  split: []
  newSession: []
  close: []
  /** 打开 SideDrawer git tab（PanelContainer 统一渲染抽屉，事件上抛） */
  openGit: []
  /** 切换 SideDrawer 开关（always-visible 按钮，不依赖 git 仓库） */
  toggleDrawer: []
  /** 返回主会话（subagent 视图退出） */
  back: []
}>()

const { t } = useI18n()
const navigation = useNavigationStore()
const sidebar = useSidebarStore()
const { isFullscreen } = usePlatformChrome()

/**
 * 折叠态 chrome 落位判据（draft-collapsed-state.html 卡 A/B/C + sidebar/spec §收起态）：
 * sidebar 折叠 && P1 → 收起/←/→ 三按钮迁入此 header。
 * P2 永不落 chrome（window-level chrome 属一个地方）。
 * 安全区 padding 由 template 的 `showChrome && !isFullscreen` 二级判断：
 * 非全屏留 pl-[88px] 让位 traffic-light（红黄绿 x16~68）；全屏（卡 B）红黄绿 OS 隐藏，header pl-4 不让位。
 */
const showChrome = computed(() => props.isFirstPanel && sidebar.collapsed)

/** 工作目录名（cwd 末段）：只显最后一级目录，避免目录+分支过长盖住右侧按钮（title 仍显全路径）。 */
const dirName = computed(() => {
  const segs = props.sessionDir.split('/').filter(Boolean)
  return segs.length ? segs[segs.length - 1] : props.sessionDir
})

/** 状态点 8 态色（DOT_CLASS SSOT，与 sidebar / overview 一致） */
const statusDotClass = computed(() => DOT_CLASS[props.status])

/** 当前状态对应的语义图标配置（icon / color / animation） */
const iconConfig = computed(() => STATUS_ICON[props.status])

/** lucide 图标名 → 组件映射 */
const ICON_COMPONENTS: Record<string, unknown> = {
  RefreshCw,
  ArrowUpCircle,
  Hourglass,
  Wrench,
  Zap,
  CheckCircle2,
  Ban,
  AlertCircle,
}
</script>
