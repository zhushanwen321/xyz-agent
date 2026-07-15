<template>
  <!--
    展示组件 · progress-zone（panel/spec.md zone ③，composer 上方）。
    draft-companion-zones §1：三态纯只读（待办/进行/完成）。
    head 可点击折叠（chevron 提示），折叠态隐藏 bar/todos。
    真实数据源（runtime Flow3 任务状态）未接入前 state 恒 null → v-if="state" 整组件自隐藏。
  -->
  <div
    v-if="state"
    class="mx-3.5 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-bg-input"
  >
    <!-- head：状态点 + 标题 + 步骤 + 折叠 chevron（点击 head toggle） -->
    <div
      class="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-[12px] transition-colors hover:bg-surface-hover"
      :title="collapsed ? t('panel.progress.expand') : t('panel.progress.collapse')"
      @click="collapsed = !collapsed"
    >
      <span
        class="size-[7px] shrink-0 rounded-full"
        :class="{
          'bg-subtle': phase === 'idle',
          'bg-accent animate-pulse-accent': phase === 'running',
          'bg-success': phase === 'done',
        }"
      />
      <span class="text-[12px] font-semibold text-fg">{{ state.title }}</span>
      <span class="font-mono text-[11px] text-subtle">{{ state.step }}</span>
      <ChevronRight
        class="ml-auto size-3 shrink-0 text-subtle transition-transform duration-[var(--duration)] ease-[var(--ease)]"
        :class="collapsed ? '' : 'rotate-90'"
      />
    </div>

    <!-- 完成态：自动收起为单行 inline（状态驱动，非用户折叠） -->
    <div v-if="phase === 'done' && !collapsed" class="flex items-center gap-2.5 px-3 pb-2">
      <span class="text-[11px] text-muted">{{ t('panel.progress.allDone') }}</span>
      <div class="h-1 flex-1 overflow-hidden rounded bg-white/[0.06]">
        <div class="h-full rounded bg-success" style="width: 100%" />
      </div>
      <span class="min-w-[30px] text-right font-mono text-[11px] text-success">100%</span>
    </div>

    <!-- 待办 / 进行：展开 todos（折叠态隐藏） -->
    <div v-else-if="!collapsed" class="px-3 pb-[11px]">
      <!-- summary bar -->
      <div class="relative mb-2.5 h-[5px] overflow-hidden rounded-[3px] bg-white/[0.06]">
        <div
          class="h-full rounded-[3px] bg-gradient-to-r from-accent to-accent-hover"
          :style="{ width: `${state.summaryPct}%` }"
        />
      </div>
      <!-- todos -->
      <div class="flex flex-col gap-[3px]">
        <div
          v-for="todo in state.todos"
          :key="todo.id"
          class="flex items-center gap-2 py-[3px] text-[12px] leading-[1.4]"
          :class="{
            'text-subtle': todo.status === 'done',
            'text-fg': todo.status === 'active',
            'text-muted': todo.status === 'pending',
          }"
        >
          <span
            class="grid size-3.5 shrink-0 place-items-center rounded-full"
            :class="{
              'bg-success text-[#06251a]': todo.status === 'done',
              'bg-accent text-white': todo.status === 'active',
              'border border-border-strong': todo.status === 'pending',
            }"
          >
            <Check v-if="todo.status === 'done'" class="size-[9px]" />
          </span>
          <span :class="{ 'line-through decoration-subtle': todo.status === 'done' }">
            {{ todo.label }}
          </span>
          <span class="ml-auto font-mono text-[10px] text-subtle">
            {{ todo.pct != null ? `${todo.pct}%` : statusLabel(todo.status) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronRight } from '@lucide/vue'

type TodoStatus = 'pending' | 'active' | 'done'

interface ProgressTodo {
  id: string
  label: string
  status: TodoStatus
  pct?: number
}

interface ProgressState {
  phase: 'idle' | 'running' | 'done'
  title: string
  step: string
  summaryPct: number
  todos: ProgressTodo[]
}

const { t } = useI18n()

defineProps<{
  /** runtime Flow3 任务态：idle / running / done。真实数据源未接入前 state 恒 null，组件自隐藏 */
  phase?: 'idle' | 'running' | 'done'
}>()

/** head 折叠态（用户点击切换） */
const collapsed = ref(false)

/** 真实进度数据源（runtime Flow3 任务状态）未接入前恒 null → v-if="state" 整组件自隐藏，不渲染假任务 */
const state = computed<ProgressState | null>(() => null)

function statusLabel(s: TodoStatus): string {
  return s === 'done' ? t('panel.progress.done') : s === 'active' ? t('panel.progress.active') : t('panel.progress.pending')
}
</script>
