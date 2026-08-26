<template>
  <!--
    展示组件 · 单会话项（7px 单一 icon 范式）。
    状态信号集中在左侧 7px 单一 icon（旋转箭头/空心圆/实心圆/空白），
    右侧仅保留时间文字。未读标记 7px accent 圆点叠在 icon 右上角。
    active=bg-surface+text-accent；hover ghost 操作（bottom-right）。
    agent-spawned session（U8）：标题旁 [AI] badge + 右键「查看父 session」菜单。
  -->
  <!-- 右键菜单用 reka ContextMenu 原语（光标定位原语级支持，PanelContainer 同为直接引 reka-ui 先例）；
       Trigger as-child 合并到根 div，不引入额外包裹层破坏既有 flex/绝对定位。 -->
  <ContextMenuRoot>
    <ContextMenuTrigger as-child>
      <div
        ref="rootEl"
        class="session-item group/item relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 transition-colors"
        :class="[
          active ? 'bg-surface' : 'hover:bg-surface-hover',
          isDead ? 'opacity-50' : '',
        ]"
        :aria-label="ariaLabel"
        @click="emit('select', session.id)"
        @mouseleave="confirming = false"
      >
      <!-- 左侧 7px 状态 icon：spinning(旋转箭头) / hollow(空心圆) / waiting / error / done / stopped / dead / 空。
           未读标记 7px accent 圆点叠在 icon 右上角（absolute + box-shadow 镂空）。 -->
      <div class="relative mt-[6px] size-[7px] shrink-0" data-testid="session-icon">
        <!-- spinning: streaming / compacting / working / retrying → 旋转箭头（accent 边框 + 透明顶边） -->
        <span v-if="iconKind === 'spinning'" class="block size-[7px] animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
        <!-- hollow: pending → accent 空心圆 -->
        <span v-else-if="iconKind === 'hollow'" class="block size-[7px] rounded-full border-[1.5px] border-accent" />
        <!-- hollow-dim: stopped → dim 空心圆 -->
        <span v-else-if="iconKind === 'hollow-dim'" class="block size-[7px] rounded-full border-[1.5px] border-neutral-dim opacity-60" />
        <!-- waiting → warn 实心圆 -->
        <span v-else-if="iconKind === 'waiting'" class="block size-[7px] rounded-full bg-warn" />
        <!-- error → danger 实心圆 -->
        <span v-else-if="iconKind === 'error'" class="block size-[7px] rounded-full bg-danger" />
        <!-- done → success 实心圆 90% -->
        <span v-else-if="iconKind === 'done'" class="block size-[7px] rounded-full bg-success opacity-90" />
        <!-- dead → neutral-dim 实心圆 50% -->
        <span v-else-if="iconKind === 'dead'" class="block size-[7px] rounded-full bg-neutral-dim opacity-50" />
        <!-- 已归档+已读 → 空（无 icon） -->
        <span v-else aria-hidden="true" />
        <!-- 未读标记：叠在 icon 右上角 -->
        <span
          v-if="unread"
          data-testid="session-unread-dot"
          class="absolute -right-0.5 -top-0.5 size-[7px] rounded-full bg-accent"
          style="box-shadow: 0 0 0 2px var(--bg)"
        />
      </div>

      <!-- 主体：label + sub（fork 血缘 / branch） -->
      <div class="min-w-0 flex-1">
        <div
          class="flex min-w-0 items-center gap-1 text-[length:var(--text-xs)] leading-[1.35]"
          :class="[
            active ? 'text-accent' : 'text-neutral-fg',
            markedDone ? 'opacity-60' : '',
          ]"
        >
          <span class="min-w-0 flex-1 truncate">{{ session.label }}</span>
          <!-- agent-spawned badge（U8）：accent 低饱和形态（bg-accent-soft + text-accent，
               对齐 popover-styles SELECTED_ITEM_CLASS 配对）；尺寸/圆角对齐同目录
               FileTreeRow badge（rounded-sm px-1 py-0.5 text-[length:var(--text-3xs)]），不抢左侧状态 icon 焦点 -->
          <span
            v-if="isAgentSpawned"
            data-testid="session-agent-badge"
            class="shrink-0 rounded-sm bg-accent-soft px-1 py-0.5 font-mono text-[length:var(--text-3xs)] leading-none text-accent"
          >{{ t('sidebar.sessionItem.agentBadge') }}</span>
        </div>
        <div
          class="mt-0.5 truncate font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim"
          data-testid="sidebar-session-sub"
        >
          <!-- 分支血缘元信息（spec §8.5：分支 session 自身显示「↑ fork 自 <父名>」）优先；
               无血缘则显 branch（git 分支）；都无则回退 cwd 末段，避免空行。 -->
          <template v-if="session.parentSession">
            <span class="fork-lineage text-accent/80">{{ t('sidebar.sessionItem.forkFrom') }} {{ session.parentLabel || session.parentSession }}</span>
          </template>
          <template v-else-if="session.gitBranch">{{ session.gitBranch }}</template>
          <template v-else>{{ dirName }}</template>
        </div>
      </div>

      <!-- 右侧：仅时间文字（状态信号已移至左侧 7px icon） -->
      <span
        class="mt-1 shrink-0 font-mono text-[length:var(--text-3xs)] leading-[1.35] text-neutral-dim"
      >{{ timeLabel }}</span>

      <!-- hover ghost 操作（spec §3 SessionItem hover 帧）。
           位置 bottom-right（遮 meta 而非 dirName，与 demo 对齐）；删除走两段式确认。 -->
      <div
        class="absolute bottom-0.5 right-1 gap-0.5"
        :class="confirming ? 'flex' : 'flex opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100'"
      >
        <Button
          v-if="!confirming"
          variant="ghost"
          size="icon"
          data-testid="mark-done-btn"
          class="size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
          :class="markedDone ? 'text-success' : ''"
          :title="markedDone ? t('sidebar.sessionItem.unmarkDone') : t('sidebar.sessionItem.markDone')"
          @click.stop="onMarkDone"
        >
          <Archive class="size-[13px]" :class="markedDone ? 'fill-current' : ''" />
        </Button>
        <Button
          v-if="!confirming"
          variant="ghost"
          size="icon"
          class="size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
          :title="t('sidebar.sessionItem.rename')"
          @click.stop="emit('rename', session.id)"
        >
          <Pencil class="size-[13px]" />
        </Button>
        <!-- 归入项目（D14 语义修正 2026-08-04）：Popover 菜单列全部 project，点击即归类。
             归类可逆（可再点其他 project / 默认项目），无需两段确认。 -->
        <Popover v-if="!confirming" :open="assignOpen" @update:open="assignOpen = $event">
          <PopoverTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              data-testid="assign-project-btn"
              class="size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
              :title="t('sidebar.sessionItem.assignToProject')"
              @click.stop="assignOpen = true"
            >
              <FolderKanban class="size-[13px]" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" :collision-padding="8" class="w-44 p-1">
            <div class="flex flex-col gap-px">
              <!-- 默认项目项 id=''：未归类 session 的 projectId 是 undefined，必须归一为空串才能命中高亮（review S-2） -->
              <Button
                v-for="p in assignTargets"
                :key="p.id"
                variant="ghost"
                data-testid="assign-project-option"
                class="h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-[length:var(--text-xs)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
                :class="(session.projectId || '') === p.id ? 'text-accent' : ''"
                @click="onAssign(p.id)"
              >
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="(session.projectId || '') === p.id ? 'bg-accent' : 'bg-transparent'"
                />
                <span class="truncate">{{ p.name || t('sidebar.projectSwitcher.defaultName') }}</span>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          variant="ghost"
          size="icon"
          :class="confirming
            ? 'size-[22px] rounded-sm bg-danger text-neutral-fg'
            : 'size-[22px] rounded-sm text-neutral-mid hover:bg-surface-hover hover:text-danger'"
          :title="confirming ? t('sidebar.sessionItem.deleteConfirm') : t('sidebar.sessionItem.delete')"
          @click.stop="onRemoveClick"
        >
          <Check v-if="confirming" class="size-[13px]" />
          <Trash2 v-else class="size-[13px]" />
        </Button>
      </div>
      </div>
    </ContextMenuTrigger>
    <!-- 「查看父 session」右键菜单项：仅 agent 发起且带父 id 的 session 挂内容
         （条件渲染整块 Portal——其余 session 右键无任何菜单项，不吞 native menu 之外的语义）。
         跳转逻辑由上层接线，本组件只保证事件链 emit navigateParent。 -->
    <ContextMenuPortal v-if="hasAgentParent">
      <ContextMenuContent
        data-testid="session-context-menu"
        class="z-[1100] min-w-[160px] rounded-md border border-border-strong bg-bg-elevated p-1 text-neutral-fg shadow-2 outline-none"
      >
        <ContextMenuItem
          data-testid="session-view-parent-item"
          class="flex h-auto w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[length:var(--text-xs)] text-neutral-mid outline-none hover:bg-surface-hover hover:text-neutral-fg [&_svg]:size-[13px]"
          @select="onViewParent"
        >
          <CornerLeftUp />
          <span>{{ t('sidebar.sessionItem.viewParent') }}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onClickOutside } from '@vueuse/core'
import { Check, Pencil, Trash2, Archive, FolderKanban, CornerLeftUp } from '@lucide/vue'
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
} from 'reka-ui'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useProjectStore } from '@/stores/project'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { dirNameOf } from '@xyz-agent/ui'
import { isUnread, isMarkedDone, toggleMarkedDone } from '@/composables/useSessionMarkers'

/** 左侧状态 icon 种类（7px 单一 icon 范式）。 */
type IconKind = 'spinning' | 'hollow' | 'hollow-dim' | 'waiting' | 'error' | 'done' | 'dead' | 'empty'

/**
 * 展示组件 · 单会话项（spec §5.6A / D12 列表主行范式）。
 * 左未读点 + 右异常态 badge，hover ghost 操作。状态图标（§5.6B）不在此渲染。
 */
const { t } = useI18n()

const props = defineProps<{
  session: {
    id: string
    label: string
    cwd: string
    lastActiveAt: number
    status?: string
    gitBranch?: string
    /** 父 session 文件路径/id（fork 血缘键）。有值则为分支 session，sub 行显示血缘元信息。 */
    parentSession?: string
    /** 父 session 显示名（血缘展示用，SessionList 容器可注入避免重复查找父 label）。 */
    parentLabel?: string
    /** 归属 project id（D14 语义修正；空/undefined = 未归类，归入默认项目聚合）。 */
    projectId?: string
    /** 发起来源（agent-managed-session U8）：'agent' = agent 经 session-manager 创建，标题旁显 [AI] badge。 */
    spawnSource?: 'user' | 'agent'
    /** 父 agent session id（U8）：spawnSource='agent' 时由 runtime 注入，右键「查看父 session」用。 */
    parentAgentSessionId?: string
  }
  active: boolean
  status: DerivedStatus
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
  /** 归入项目（D14 语义修正）：payload 单对象（规则 #1）。projectId 空串 = 归回默认项目。 */
  setProject: [{ sessionId: string; projectId: string }]
  /** 查看父 session（U8）：payload 单字符串 = parentAgentSessionId（与 select 同形）。
   *  跳转本身由上层（Sidebar/store）接线，本组件只发事件。 */
  navigateParent: [parentAgentSessionId: string]
}>()

// ── 归入项目菜单（D14 语义修正 2026-08-04）──
const projectStore = useProjectStore()
const assignOpen = ref(false)
/** 归类目标列表：默认项目（未归类聚合）+ 全部命名 project。归回默认 = projectId 空串。 */
const assignTargets = computed(() => [
  { id: '', name: t('sidebar.projectSwitcher.defaultName') },
  ...projectStore.projects.filter((p) => p.name).map((p) => ({ id: p.id, name: p.name })),
])
/** 点击归类：emit + 关菜单（归类可逆，无需两段确认） */
function onAssign(projectId: string): void {
  emit('setProject', { sessionId: props.session.id, projectId })
  assignOpen.value = false
}

/** dead session（进程已退出）置灰，仍可点击（点击触发 restore 重开） */
const isDead = computed(() => props.session.status === 'dead')

// ── agent-spawned 标记（U8）──
/** agent 经 session-manager 创建的 session：标题旁 [AI] badge。 */
const isAgentSpawned = computed(() => props.session.spawnSource === 'agent')
/** badge 只标来源；右键菜单还需父 id 才有可导航目标（menu item 与 Portal 同条件渲染）。 */
const hasAgentParent = computed(
  () => isAgentSpawned.value && !!props.session.parentAgentSessionId,
)
/** 菜单项点击：向上 emit 父 session id。守卫除防御外还承担 TS 窄化
 *  （props 字段 string|undefined → emit 要求 string），不可删。 */
function onViewParent(): void {
  const parent = props.session.parentAgentSessionId
  if (!parent) return
  emit('navigateParent', parent)
}

/**
 * 删除两段式确认态。首次点击进入红底确认态（不 emit），再次点击才 emit delete。
 * 多路 reset 防红按钮长期停留：mouseleave（模板兜底）、失焦（watch active）、
 * Esc 键、点击外部（onClickOutside）。
 */
const confirming = ref(false)
function onRemoveClick(): void {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  emit('delete', props.session.id)
}

/** 根元素引用（onClickOutside 目标） */
const rootEl = ref<HTMLElement | null>(null)

/** 失焦自动重置：切到其它 session（active → false）时清掉残留确认态 */
watch(
  () => props.active,
  (active) => {
    if (!active) confirming.value = false
  },
)

/** Esc 取消：从 SessionList 接收单一 Esc 监听（避免每实例注册 window listener）。
 *  watch escCount 变化 → 清 confirming 态（不影响全局快捷键）。 */
const escCount = inject<Ref<number>>('sessionItemEsc', ref(0))
watch(escCount, () => {
  if (confirming.value) confirming.value = false
})

/** 点击外部取消：点该 item 外部时清掉确认态 */
onClickOutside(rootEl, () => {
  confirming.value = false
})

/**
 * 左侧 7px 状态 icon 映射（单一 icon 范式）。
 * spinning: streaming/compacting/working/retrying → 旋转箭头（accent 边框+透明顶边）
 * hollow: pending → accent 空心圆
 * hollow-dim: stopped → dim 空心圆
 * waiting: 等用户操作 → warn 实心圆
 * error: 出错 → danger 实心圆
 * done: 正常完成 → success 实心圆 90%
 * dead: 进程退出 → neutral-dim 实心圆 50%
 * empty: 已归档+已读 → 无 icon
 */
const iconKind = computed<IconKind>(() => {
  if (isDead.value) return 'dead'
  if (markedDone.value && !unread.value) return 'empty'
  switch (props.status) {
    case 'streaming':
    case 'working':
    case 'compacting':
      return 'spinning'
    case 'pending':
      return 'hollow'
    case 'waiting':
    case 'retrying':
      return 'waiting'
    case 'error':
      return 'error'
    case 'stopped':
      return 'hollow-dim'
    default:
      return 'done'
  }
})

/** 工作目录名（cwd 末段），长路径只显末段防溢出（dirNameOf 收敛到 logic/path SSOT）。
 *  仅在无 fork 血缘且无 gitBranch 时作为副标题兜底（避免空行）。 */
const dirName = computed(() => dirNameOf(props.session.cwd))

/** 时间格式化：复用 logic 层相对时间纯函数（与 SessionCard 同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))

// ── 未读 + 标记完成状态 ──
const unread = computed(() => isUnread(props.session.id))
const markedDone = computed(() => isMarkedDone(props.session.id))

/** 无障碍 label：归档态把归档语义拼进 label，让屏幕阅读器读出「已归档: <名称>」。
 *  背景是归档态移除了可见的「已归档」文字（改用 opacity-60 降权），opacity 不影响 a11y，
 *  故在此补回语义。 */
const ariaLabel = computed(() =>
  markedDone.value
    ? `${t('sidebar.sessionItem.archived')}: ${props.session.label}`
    : props.session.label,
)

function onMarkDone(): void {
  toggleMarkedDone(props.session.id)
}
</script>

