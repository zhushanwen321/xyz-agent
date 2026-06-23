<template>
  <!--
    展示组件 · progress-zone（panel/spec.md zone ③，composer 上方）。
    draft-companion-zones §1：三态纯只读（待办/进行/完成）。
    head 可点击折叠（chevron 提示），折叠态隐藏 bar/todos。
    数据：mock/composer-data.ts MOCK_PROGRESS_STATES（runtime Flow3 落地后改真实数据源）。
  -->
  <div
    v-if="state"
    class="mx-3.5 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-bg-input"
  >
    <!-- head：状态点 + 标题 + 步骤 + 折叠 chevron（点击 head toggle） -->
    <div
      class="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-[12px] transition-colors hover:bg-surface-hover"
      :title="collapsed ? '展开' : '收起'"
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
      <span class="text-[12.5px] font-semibold text-fg">{{ state.title }}</span>
      <span class="font-mono text-[11px] text-subtle">{{ state.step }}</span>
      <ChevronRight
        class="ml-auto size-3 shrink-0 text-subtle transition-transform duration-[var(--duration)] ease-[var(--ease)]"
        :class="collapsed ? '' : 'rotate-90'"
      />
    </div>

    <!-- 完成态：自动收起为单行 inline（状态驱动，非用户折叠） -->
    <div v-if="phase === 'done' && !collapsed" class="flex items-center gap-2.5 px-3 pb-2">
      <span class="text-[11px] text-muted">全部完成</span>
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
import { Check, ChevronRight } from '@lucide/vue'
import { MOCK_PROGRESS_STATES, type MockProgressState, type TodoStatus } from '@/api/mock/composer-data'

const props = withDefaults(
  defineProps<{
    /** 演示态（mock 期）：idle / running / done。runtime 落地后改真实 phase 数据源 */
    phase?: 'idle' | 'running' | 'done'
  }>(),
  { phase: 'running' },
)

/** head 折叠态（用户点击切换） */
const collapsed = ref(false)

const state = computed<MockProgressState | null>(() => MOCK_PROGRESS_STATES[props.phase] ?? null)

function statusLabel(s: TodoStatus): string {
  return s === 'done' ? '完成' : s === 'active' ? '进行中' : '待开始'
}
</script>
