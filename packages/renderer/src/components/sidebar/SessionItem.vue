<template>
  <!--
    展示组件 · 单会话项（draft-five-states §1）。
    flex [dot] [main] [time]；active = surface-2 背景（Card-Active，design-system §2）+ inset accent-ring。
    状态点 5 态（D6）：running/waiting 脉冲，done/stopped/error 静态。
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
    <!-- 状态指示：running/waiting 转菊花（比脉冲圆点在密集列表更醒目），done/stopped/error 静态圆点 -->
    <Loader2
      v-if="showSpinner"
      data-testid="session-spinner"
      class="mt-[2px] size-[14px] shrink-0 animate-spin"
      :class="spinnerTextClass"
    />
    <span v-else class="size-2 mt-1 shrink-0 rounded-full" :class="dotClass" />
    <div class="min-w-0 flex-1">
      <div
        class="truncate text-[12.5px] leading-[1.35]"
        :class="active ? 'text-accent' : 'text-fg'"
      >
        {{ session.label }}
      </div>
      <div class="mt-0.5 truncate font-mono text-[10.5px] leading-[1.3] text-subtle">
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
      class="absolute bottom-1 right-1.5 gap-1"
      :class="confirming ? 'flex' : 'hidden group-hover:flex'"
    >
      <Button
        v-if="!confirming"
        variant="ghost"
        size="icon"
        class="size-[22px] rounded-[5px] border border-border-strong bg-surface text-muted hover:bg-surface-hover hover:text-fg"
        title="重命名"
        @click.stop="emit('rename', session.id)"
      >
        <Pencil class="size-[13px]" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        :class="confirming
          ? 'size-[22px] rounded-[5px] border border-danger bg-danger text-white'
          : 'size-[22px] rounded-[5px] border border-border-strong bg-surface text-muted hover:bg-surface-hover hover:text-danger'"
        :title="confirming ? '确认删除？' : '删除'"
        @click.stop="onRemoveClick"
      >
        <Check v-if="confirming" class="size-[13px]" />
        <Trash2 v-else class="size-[13px]" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 状态点 class 映射（D6 五态，design-tokens SSOT 语义色）。
 * running/waiting 用同心环 pulse 动画（与 SessionCard 对齐）；
 * done/stopped/error 静态色。
 */
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

/** 状态点语义类：背景色 + 脉冲动画（DOT_CLASS 收敛到 logic/sessionStatus SSOT） */
const dotClass = computed(() => DOT_CLASS[props.status])

/** running/waiting 态用转菊花替代圆点（活跃态更醒目） */
const showSpinner = computed(() => shouldShowSpinner(props.status))

/** spinner 图标色：running→accent 蓝，waiting→warning 橙 */
const spinnerTextClass = computed(() => SPINNER_TEXT_CLASS[props.status as 'running' | 'waiting'])

/** 工作目录名（cwd 末段），长路径只显末段防溢出（dirNameOf 收敛到 logic/path SSOT） */
const dirName = computed(() => dirNameOf(props.session.cwd))

/** 时间格式化：复用 logic 层相对时间纯函数（与 SessionCard 同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))

import { computed, inject, ref, watch, type Ref } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Check, Pencil, Trash2, Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { DOT_CLASS, shouldShowSpinner, SPINNER_TEXT_CLASS } from '@/composables/logic/sessionStatus'
import { dirNameOf } from '@/composables/logic/path'
</script>

