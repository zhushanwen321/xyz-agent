<template>
  <!--
    展示组件 · 单会话项（draft-eight-states §1）。
    flex [icon] [main] [time]；active = surface-2 背景（Card-Active，design-system §2）+ inset accent-ring。
    状态图标 8 态（方案 C 优化版 v3）：streaming/pending/compacting/waiting/retrying 动态图标，done/stopped/error 静态图标。
  -->
  <div
    ref="rootEl"
    class="session-item group relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-[7px] transition-colors"
    :class="[
      active ? 'bg-surface-2 ring-1 ring-inset ring-accent-ring' : 'hover:bg-surface-hover',
      isDead ? 'opacity-50' : '',
    ]"
    @click="emit('select', session.id)"
    @mouseleave="confirming = false"
  >
    <!-- 状态指示：按 STATUS_ICON 渲染语义图标（方案 C 优化版 v3） -->
    <component
      :is="ICON_COMPONENTS[iconConfig.icon]"
      data-testid="sidebar-session-icon"
      :data-icon="iconConfig.icon"
      class="mt-[2px] size-[14px] shrink-0"
      :class="[iconConfig.color, iconConfig.animation]"
    />
    <div class="min-w-0 flex-1">
      <div
        class="truncate text-[12px] leading-[1.35]"
        :class="active ? 'text-accent' : 'text-fg'"
      >
        {{ session.label }}
      </div>
      <div class="mt-0.5 truncate font-mono text-[10px] leading-[1.3] text-subtle">
        {{ dirName }}
      </div>
    </div>
    <span class="shrink-0 pt-1 font-mono text-[10px] leading-[1.35] text-subtle">
      {{ timeLabel }}
    </span>
    <!-- hover 操作按钮（重命名/删除）放卡片右下角，不再遮盖右上角的时间展示。
         按钮浮于 dirName/gitBranch 之上，底色保证可读。
         删除采用原地两段式确认：首次点击→变红确认态，再次点击才真正 emit delete。 -->
    <div
      class="absolute top-0.5 right-1 gap-1"
      :class="confirming ? 'flex' : 'flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'"
    >
      <Button
        v-if="!confirming"
        variant="ghost"
        size="icon"
        class="size-[22px] rounded-sm border border-border-strong bg-surface text-muted hover:bg-surface-hover hover:text-fg"
        :title="t('sidebar.sessionItem.rename')"
        @click.stop="emit('rename', session.id)"
      >
        <Pencil class="size-[13px]" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        :class="confirming
          ? 'size-[22px] rounded-sm border border-danger bg-danger text-fg'
          : 'size-[22px] rounded-sm border border-border-strong bg-surface text-muted hover:bg-surface-hover hover:text-danger'"
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
import { Check, Pencil, Trash2, RefreshCw, ArrowUpCircle, Hourglass, Wrench, Zap, CheckCircle2, Ban, AlertCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { STATUS_ICON } from '@/composables/logic/sessionStatus'
import { dirNameOf } from '@/composables/logic/path'

/** lucide 图标名 → 组件映射（用于 STATUS_ICON 的动态组件渲染） */
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

/**
 * 展示组件 · 单会话项（draft-eight-states §1）。
 * flex [icon] [main] [time]；active = surface-2 背景（Card-Active，design-system §2）+ inset accent-ring。
 * 状态图标 8 态（方案 C 优化版 v3），语义图标 + 动画。
 */
const { t } = useI18n()

const props = defineProps<{
  session: {
    id: string
    label: string
    cwd: string
    lastActiveAt: number
    status?: string
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

/** 当前状态对应的语义图标配置（icon / color / animation） */
const iconConfig = computed(() => STATUS_ICON[props.status])

/** 工作目录名（cwd 末段），长路径只显末段防溢出（dirNameOf 收敛到 logic/path SSOT） */
const dirName = computed(() => dirNameOf(props.session.cwd))

/** 时间格式化：复用 logic 层相对时间纯函数（与 SessionCard 同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))
</script>

