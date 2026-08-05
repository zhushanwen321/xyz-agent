<template>
  <!--
    展示组件 · 单会话项（spec §5.6A / D12 列表主行范式）。
    状态信号「左未读点 + 右异常 badge」空间分离（消除双圆点重叠 + 常态归零）：
    - 左侧：8px 占位圆点，未读时 accent 实心（不脉动，固定占位保 label 对齐）
    - 右侧：异常态 badge（running 脉动小条 / waiting … / error !），done 无 badge 仅耗时，dead 整行 opacity-50
    active=bg-surface+text-accent；hover ghost 操作（bottom-right 遮 meta，spec §3 hover 帧）。
    STATUS_ICON（§5.6B 图标范式）不在此渲染——保留给 PanelHeader / git 等非列表主行场景。
  -->
  <div
    ref="rootEl"
    class="session-item group/item relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-[7px] transition-colors"
    :class="[
      active ? 'bg-surface' : 'hover:bg-surface-hover',
      isDead ? 'opacity-50' : '',
    ]"
    :aria-label="ariaLabel"
    @click="emit('select', session.id)"
    @mouseleave="confirming = false"
  >
    <!-- 左侧未读圆点：固定 8px 占位保 label 对齐（spec §5.6A D12），未读 accent 实心，不脉动。
         不用 absolute + 负偏移（双圆点重叠 bug 的温床），改流内占位。 -->
    <span
      v-if="unread"
      data-testid="session-unread-dot"
      class="mt-1 size-2 shrink-0 rounded-full bg-accent transition-colors"
    />
    <span v-else class="mt-1 size-2 shrink-0 rounded-full bg-transparent" aria-hidden="true" />

    <!-- 主体：label + sub（fork 血缘 / branch） -->
    <div class="min-w-0 flex-1">
      <div
        class="truncate text-[12px] leading-[1.35]"
        :class="[
          active ? 'text-accent' : 'text-neutral-fg',
          markedDone ? 'opacity-60' : '',
        ]"
      >
        {{ session.label }}
      </div>
      <div
        class="mt-0.5 truncate font-mono text-[10px] leading-[1.3] text-neutral-dim"
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

    <!-- 右侧 meta 槽位：状态 badge 矩阵（spec §5.6A D12）。
         running=脉动小条+耗时 / waiting=… 胶囊 / error=! 胶囊 / done·stopped·dead 无 badge 仅耗时。
         hover 时整单元 visibility:hidden 让位 ghost 操作（保留占位防跳动，spec §3 hover 帧）。 -->
    <div
      class="mt-[3px] shrink-0 font-mono text-[10px] leading-[1.35] text-neutral-dim group-hover/item:invisible"
      data-testid="sidebar-session-meta"
    >
      <!-- running：脉动小条 + 耗时（accent，同色同单元） -->
      <span
        v-if="badgeKind === 'running'"
        data-testid="session-badge-running"
        class="si-badge inline-flex items-center gap-1 rounded-sm bg-accent-soft px-1 leading-none text-accent"
      >
        <span class="inline-block h-[9px] w-[3px] rounded-[2px] bg-accent animate-[pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none" />
        <span v-if="timeLabel" class="text-[10px] text-neutral-dim">{{ timeLabel }}</span>
      </span>
      <!-- waiting：… 胶囊（warn）— 需要用户介入 -->
      <span
        v-else-if="badgeKind === 'waiting'"
        data-testid="session-badge-waiting"
        class="inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-warn-soft px-1 text-[10px] font-semibold leading-none text-warn"
      >…</span>
      <!-- error：! 胶囊（danger）— 需要用户介入 -->
      <span
        v-else-if="badgeKind === 'error'"
        data-testid="session-badge-error"
        class="inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-danger-soft px-1 text-[10px] font-semibold leading-none text-danger"
      >!</span>
      <!-- done / stopped / dead：无 badge，仅耗时文字 -->
      <span v-else>{{ timeLabel }}</span>
    </div>

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
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { onClickOutside } from '@vueuse/core'
import { Check, Pencil, Trash2, Archive } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { dirNameOf } from '@xyz-agent/ui'
import { isUnread, isMarkedDone, toggleMarkedDone } from '@/composables/useSessionMarkers'

/** 右侧 badge 矩阵种类（spec §5.6A D12）。 */
type BadgeKind = 'running' | 'waiting' | 'error' | 'none'

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
  }
  active: boolean
  status: DerivedStatus
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
}>()

/** dead session（进程已退出）置灰，仍可点击（点击触发 restore 重开） */
const isDead = computed(() => props.session.status === 'dead')

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
 * 右侧 badge 矩阵映射（spec §5.6A D12）。
 * streaming/working/compacting/pending → running 脉动小条；
 * waiting/retrying → waiting … 胶囊；error → ! 胶囊；
 * done/stopped → none（仅耗时文字）；dead 由 isDead 抑制 badge（整行 opacity 表达）。
 */
const badgeKind = computed<BadgeKind>(() => {
  // dead 由整行 opacity-50 表达，无 badge（spec §5.6A）
  if (isDead.value) return 'none'
  switch (props.status) {
    case 'streaming':
    case 'working':
    case 'compacting':
    case 'pending':
      return 'running'
    case 'waiting':
    case 'retrying':
      return 'waiting'
    case 'error':
      return 'error'
    default:
      // done / stopped：终态，无 badge，仅耗时文字
      return 'none'
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

