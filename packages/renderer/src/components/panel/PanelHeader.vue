<template>
  <!--
    展示组件 · panel-header（panel/spec.md zone ①）。
    布局：状态点 + breadcrumb（项目▸会话▸分支，shell/spec §四）+ ... + [drawer|git] + 更多。
    breadcrumb 三段：项目名（cwd 末段）▸ 会话名 ▸ 分支名（mono+accent）。
    popover 点击跳转 DEFERRED（shell/spec §八，属 G3 联调）；v1 纯展示。
    v2：移除 split 后无 split/新建会话/关闭按钮（原双 panel 专属操作）。
    更多菜单（G2-005 rename 等）DEFERRED hide。
    拖拽区（shell/spec §七-6）：header 空白 -webkit-app-region:drag，交互元素 no-drag。
    高度 38px 对齐 v6-spec-shell（2026-08 裁决：v6 demo + v6-spec-shell.html 为真值）：
      main-panel 顶=AppShell p-3(12)+border(1)=y13，h-38 → 中线 y=13+19=32，
      与红黄绿中线（trafficLightPosition {16,26}：26+6=32）和 AppNavControls 按钮中线（top-21+h-22）三处对齐。
      右侧 drawer/git 按钮 size-22 / jsonl 按钮 h-5 在 38px header 内垂直居中（items-center）。
    折叠态 chrome 落位（sidebar/spec.md §收起态 + draft-collapsed-state.html 卡 A/B/C）：
    sidebar 折叠时，收起/←/→ 三按钮迁入此 header 最左侧（chrome 槽位）。
    安全区 padding：非全屏留 pl-[88px] 让位窗口左上 traffic-light（红黄绿原生 x16~68，header 内容起 x≈100，
    chrome 按钮与红黄绿拉开约 32px 呼吸，与浮层 AppNavControls 非折叠位 left-100 一致）；全屏态红黄绿 OS 隐藏，header pl-4（卡 B「h-nav 紧贴左」）。
    唤回侧栏靠 ⌘B + 此 chrome 按钮（rail-restore 已移除）。
  -->
  <header
    class="flex h-[38px] flex-shrink-0 items-center gap-2 bg-bg-elevated px-3.5 [-webkit-app-region:drag]"
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
        class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
        :title="sidebar.collapsed ? t('panel.header.toggleSidebarExpand') : t('panel.header.toggleSidebarCollapse')"
        :aria-label="t('panel.header.toggleSidebarAria')"
        data-testid="sidebar-collapse-toggle"
        @click="sidebar.toggleCollapsed()"
      >
        <PanelLeftOpen v-if="sidebar.collapsed" class="size-[14px]" />
        <PanelLeftClose v-else class="size-[14px]" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim"
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
        class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-dim"
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
      class="h-[22px] w-[22px] shrink-0 gap-1 rounded-md text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
      :title="t('panel.header.backToMain')"
      data-testid="subagent-back-btn"
      @click="emit('back')"
    >
      <ArrowLeft class="size-[14px]" />
    </Button>
    <span
      v-if="viewingSubagent"
      class="min-w-0 shrink truncate text-[12px] font-medium text-neutral-fg"
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
    <!-- breadcrumb（shell/spec §四：项目 ▸ 分支，落点在 main-header 内）。
         不显会话名（仅目录 + 分支两段），避免与目录视觉重复。
         shrink + min-w-0：长目录+分支时截断优先发生于此，绝不盖右侧 3 按钮（按钮组 ml-auto + shrink-0）。 -->
    <nav v-if="!viewingSubagent" class="flex min-w-0 shrink items-center gap-1 [-webkit-app-region:no-drag]">
      <ol class="flex min-w-0 items-center gap-1 text-[12px]">
        <li class="flex min-w-0 items-center gap-1.5">
          <Folder class="size-3 shrink-0 opacity-70 text-neutral-dim" />
          <span
            class="truncate font-mono text-[12px] font-semibold text-neutral-fg"
            :title="`${t('panel.header.workingDir')}：${sessionDir}`"
          >{{ dirName }}</span>
        </li>
        <template v-if="gitBranch">
          <li aria-hidden="true" class="text-neutral-dim opacity-50">
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
      <!-- ExtensionHost panel.header 挂载点（audit §12.1，MountPointRegistry panel.header）。
           plugin 经 views.update 贡献 header action 视图 → ViewHost 渲染。
           empty="hidden"：无贡献时整组件零 DOM，不挤压右侧内置按钮。见 02-extension-host-wiring.md。 -->
      <ViewHost
        v-if="sessionId"
        view-id="panel.header"
        :session-id="sessionId"
        empty="hidden"
      />
      <!-- session JSONL 文件名（id 前 8 位 + .jsonl）：点击复制磁盘真实绝对路径。
           正常态用主 sessionFile，overlay 态（subagent/agent call）用 overlaySessionFile。
           路径为空（pi 延迟写入窗口，规则 #6）时不渲染。放右侧按钮组最前，正常态与 overlay 态复用同一位。 -->
      <Button
        v-if="displayFile"
        variant="ghost"
        data-testid="panel-session-file"
        class="h-5 shrink-0 gap-1 rounded px-1 font-mono text-[11px] text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
        :title="t('panel.header.copySessionFile')"
        @click="copy(displayFile, 'file')"
      >
        <Check v-if="copied === 'file'" class="size-3 text-accent" />
        <FileText v-else class="size-3 opacity-60" />
        <span>{{ shortFileName }}</span>
      </Button>
      <!-- SideDrawer toggle（always-visible，不依赖 git 仓库）。
           非折叠态显此按钮；折叠态 chrome 按钮组已含侧栏切换。 -->
      <Button
        v-if="!showChrome"
        variant="ghost"
        size="icon"
        class="size-[22px] rounded-md text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
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
        class="relative size-[22px] rounded-md text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg [-webkit-app-region:no-drag]"
        :title="t('panel.header.gitStatus')"
        @click="emit('openGit')"
      >
        <GitBranch class="size-[15px]" />
        <span
          v-if="gitIndicator.hasChanges"
          class="absolute right-1 top-1 size-1.5 rounded-full"
          :class="gitIndicator.conflict ? 'bg-danger' : 'bg-warn'"
          aria-hidden="true"
        />
      </Button>
      <!-- 三点更多 ⋯（G2-005 rename 等）全 DEFERRED，按 G3-002 hide 规则不显示 -->
    </div>
  </header>
</template>

<script setup lang="ts">
 
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, ChevronRight, GitBranch, PanelLeftOpen, PanelLeftClose, PanelRight, ArrowLeft, ArrowRight, RefreshCw, ArrowUpCircle, Hourglass, Wrench, Zap, CheckCircle2, Ban, AlertCircle, FileText, Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useNavigationStore } from '@/stores/navigation'
import { useSidebarStore } from '@/stores/sidebar'
import { usePlatformChrome } from '@/composables/effects/usePlatformChrome'
import { useCopy } from '@/composables/panel/useCopy'
import { ViewHost } from '@xyz-agent/ui/extension-host'
import type { DerivedStatus } from '@/types'
import type { GitIndicator } from '@/composables/features/file-tree/useGitStatus'
import { STATUS_ICON } from '@/composables/logic/sessionStatus'
import { formatShortSessionFile } from '@/composables/logic/session-file-format'

const props = defineProps<{
  sessionLabel: string
  sessionDir: string
  /** 当前 session id（ExtensionHost panel.header 挂载点 ViewHost 路由键） */
  sessionId?: string
  /** session JSONL 绝对路径（pi 延迟写入窗口可能为空，不渲染文件名） */
  sessionFile?: string
  gitBranch?: string
  /** git 脏状态指示（驱动右侧 git 图标按钮显隐 + 脏状态点色）。hasRepo=false 不渲染按钮 */
  gitIndicator?: GitIndicator
  status: DerivedStatus
  /** 是否在查看 subagent 对话流（显示返回按钮，隐藏正常态内容） */
  viewingSubagent?: boolean
  /** subagent 视图标题（agent 名称 + subagentId 摘要） */
  subagentLabel?: string
  /** overlay 态 JSONL 路径（subagent/agent call 对话流文件，正常态不用） */
  overlaySessionFile?: string
}>()

const emit = defineEmits<{
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
 * sidebar 折叠 → 收起/←/→ 三按钮迁入此 header。
 * v2：单 panel 恒 P1，不再需要 isFirstPanel 判据。
 * 安全区 padding 由 template 的 `showChrome && !isFullscreen` 二级判断：
 * 非全屏留 pl-[88px] 让位 traffic-light（红黄绿 x16~68）；全屏（卡 B）红黄绿 OS 隐藏，header pl-4 不让位。
 */
const showChrome = computed(() => sidebar.collapsed)

/** 工作目录名（cwd 末段）：只显最后一级目录，避免目录+分支过长盖住右侧按钮（title 仍显全路径）。 */
const dirName = computed(() => {
  const segs = props.sessionDir.split('/').filter(Boolean)
  return segs.length ? segs[segs.length - 1] : props.sessionDir
})

/** 当前状态对应的语义图标配置（icon / color / animation） */
const iconConfig = computed(() => STATUS_ICON[props.status])

/**
 * 当前要展示/复制的 JSONL 路径：overlay 态用 overlaySessionFile（subagent/agent call 对话流），
 * 正常态用 sessionFile（主 session）。overlay 态无 overlaySessionFile 时不 fallback 主 sessionFile。
 */
const displayFile = computed(() =>
  props.viewingSubagent ? props.overlaySessionFile : props.sessionFile,
)

/** session JSONL 短文件名（前 8 位 + .jsonl）；displayFile 为空时返回空串 */
const shortFileName = computed(() => (displayFile.value ? formatShortSessionFile(displayFile.value) : ''))

/** 复制反馈（点击文件名后 1.2s 显示 Check 图标） */
const { copied, copy } = useCopy()

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
