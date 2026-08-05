<!--
  TasksPanel —— SideDrawer Tasks tab 的 body 内容。
  顶部 goal 卡片（有 goal 时显）+ 下方 todo 列表（有 todos 时显），同一滚动区。
  无 goal 且无 todo 时显空态（理论上不达：SideDrawer 在 hasData=false 时不显 Tasks tab icon，
  但作为 v-else-if tasks 分支的防御性兜底）。

  数据源（只读不写，session 级分区）：
  · goal → tasksStore.getGoal(sessionId)（含 liveStatus/widget 实时字段）
  · todos → tasksStore.getTodos(sessionId)（原始数组，准确三态）
  · 计数 → tasksStore.getTodoCount(sessionId)（done/total）

  blocked goal 视觉置顶：goal 卡片用 Tailwind order-first，确保余光优先捕获（即使 DOM 顺序在后）。
  todo 三态：pending 空心圆 / in_progress 脉冲点 / completed 划线。
-->
<template>
  <div class="tasks-panel flex flex-col gap-3 p-3" data-testid="tasks-panel">
    <!-- goal 卡片（有 goal 时显，blocked 时 order-first 视觉置顶） -->
    <GoalCard
      v-if="goal"
      :goal="goal"
      :session-id="sessionId"
      :class="isGoalBlocked ? 'order-first' : ''"
    />

    <!-- todo section（有 todos 时显） -->
    <section v-if="todos.length > 0" class="todo-section flex flex-col gap-1.5">
      <header class="flex items-center justify-between px-0.5">
        <span class="text-[11px] font-medium uppercase tracking-wide text-neutral-dim">
          {{ t('panel.panel.tasks.todoListTitle') }}
        </span>
        <span class="font-mono text-[11px] tabular-nums text-neutral-mid">{{ done }}/{{ total }}</span>
      </header>
      <ul class="todo-list flex flex-col">
        <li
          v-for="todo in todos"
          :key="todo.id"
          class="todo-item flex items-center gap-2 rounded-sm px-1.5 py-1 transition-colors hover:bg-surface-hover"
          :class="todoItemClass(todo)"
        >
          <!-- checkbox 纯展示（13x13px 圆，状态由 AI 通过 tool 改，用户不可操作） -->
          <span
            class="flex size-[13px] shrink-0 items-center justify-center rounded-full border"
            :class="todoCheckboxClass(todo)"
          >
            <!-- in_progress 脉冲点（复用全局 animate-pulse-strong：opacity+scale 呼吸） -->
            <span
              v-if="todo.status === 'in_progress'"
              class="size-[5px] animate-pulse-strong rounded-full bg-warn"
            />
            <!-- completed 勾选 -->
            <Check v-else-if="todo.status === 'completed'" class="size-2.5" />
          </span>
          <span class="todo-text min-w-0 flex-1 truncate text-[12px] leading-[1.4]">
            {{ todo.text }}
          </span>
        </li>
      </ul>
    </section>

    <!-- 空态（无 goal 且无 todo） -->
    <div
      v-if="!goal && todos.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center"
    >
      <CheckSquare class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[12px] text-neutral-dim">{{ t('panel.sideDrawer.tasksHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, CheckSquare } from '@lucide/vue'
import { useTasksStore, type TodoItem } from '@/stores/tasks'
import GoalCard from './GoalCard.vue'

const props = defineProps<{
  /** drawer 所属 panel 的 session（查 tasks store 用），null 时显空态 */
  sessionId: string | null
}>()

const { t } = useI18n()
const tasksStore = useTasksStore()

/** goal 快照（sessionId 变化时 store 自动切分区，响应式） */
const goal = computed(() =>
  props.sessionId ? tasksStore.getGoal(props.sessionId) : undefined,
)

/** 是否 blocked（用于 goal 卡片视觉置顶 order-first） */
const isGoalBlocked = computed<boolean>(() => goal.value?.liveStatus === 'blocked')

/** todo 原始数组（准确三态） */
const todos = computed<TodoItem[]>(() =>
  props.sessionId ? tasksStore.getTodos(props.sessionId) : [],
)

/** done/total 计数 */
const todoCount = computed(() =>
  props.sessionId ? tasksStore.getTodoCount(props.sessionId) : { done: 0, total: 0 },
)
const done = computed(() => todoCount.value.done)
const total = computed(() => todoCount.value.total)

/** todo item 容器 class（completed 加删除线，cancelled 置灰） */
function todoItemClass(todo: TodoItem): string {
  if (todo.status === 'completed') return 'text-neutral-dim line-through'
  if (todo.status === 'cancelled') return 'opacity-50'
  return 'text-neutral-fg'
}

/** todo checkbox class（三态）：
 * · pending → 空心圆（border-neutral-dim）
 * · in_progress → warning 软底圆（内部脉冲点）
 * · completed → success 实心圆 + 勾选
 * · cancelled → subtle 空心圆（淡化） */
function todoCheckboxClass(todo: TodoItem): string {
  switch (todo.status) {
    case 'completed':
      return 'border-success bg-success text-bg'
    case 'in_progress':
      return 'border-warn bg-warn-soft'
    case 'cancelled':
      return 'border-neutral-dim'
    default:
      return 'border-neutral-dim'
  }
}
</script>
