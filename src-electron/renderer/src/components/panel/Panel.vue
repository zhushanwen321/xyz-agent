<template>
  <!--
    容器组件 · Panel（panel/spec.md 5 zone 编排，承载一个 Session）。
    自上而下：① panel-header → ② message-stream → ③ progress-zone → ④ composer。
    git-zone（原 zone ⑤）已移除。
    激活标识（workspace/spec.md）：rounded-lg + ring-1 accent + bg-elevated 浮起；非激活 opacity 0.5。
    点击 panel body 切 active（主从焦点，非按钮区域）。
    [HISTORICAL] 原「左 2px 竖条 + inset box-shadow ring」双叠加导致激活 panel 左边 3px、其余边 1px，
    边框厚度不均；inset shadow 在直角 section 上不跟随外层 MainPanel 圆角，圆角处露 bg。
    改 ring-1（box-shadow 外发光，跟随 rounded-lg）+ 去竖条，4 边均匀且圆角覆盖。
  -->
  <section
    class="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg transition-[background-color,opacity,box-shadow] duration-[var(--duration)] ease-[var(--ease)]"
    :class="panelStateClass"
    @mousedown="onPanelMouseDown"
  >
    <PanelHeader
      :session-label="sessionLabel"
      :session-dir="sessionDir"
      :git-branch="gitBranch"
      :status="status"
      :active="active"
      :is-dual="isDual"
      @split="emit('split')"
      @new-session="emit('new-session')"
      @close="emit('close')"
    />

    <!-- ② message-stream（FG5，7 块 + 回合折叠 + auto-scroll） -->
    <MessageStream v-if="sessionId" :session-id="sessionId" />
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <MessageSquare class="size-6 text-subtle opacity-40" />
      <p class="text-[12px] text-subtle opacity-70">选择左侧会话开始</p>
    </div>

    <!-- ③④ companion zones：progress / composer 垂直 6px 紧凑成「带」。git-zone 已移除。 -->
    <div class="composer-band flex flex-shrink-0 flex-col gap-1.5">
      <!-- ③ progress-zone（composer 上方） -->
      <ProgressZone phase="running" />

      <!-- ④ composer（FG5，S1/S2/S5/S6 主路径） -->
      <Composer v-if="sessionId" :session-id="sessionId" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquare } from '@lucide/vue'
import type { DerivedStatus } from '@/types'
import PanelHeader from './PanelHeader.vue'
import ProgressZone from './ProgressZone.vue'
import MessageStream from './MessageStream.vue'
import Composer from './Composer.vue'

const props = defineProps<{
  panelId: string
  sessionId: string | null
  sessionLabel: string
  sessionDir: string
  gitBranch?: string
  status: DerivedStatus
  active: boolean
  isDual: boolean
}>()

const emit = defineEmits<{
  activate: [panelId: string]
  split: []
  'new-session': []
  close: []
}>()

/** 点击 panel body 切 active（双 panel 主从焦点）；点 header 按钮不误切（按钮自身 stopPropagation） */
function onPanelMouseDown(e: MouseEvent): void {
  if (!props.isDual || props.active) return
  // 按钮点击由 reka-ui/Button 内部处理，这里检查最近 button 祖先避免误切
  if ((e.target as HTMLElement).closest('button')) return
  emit('activate', props.panelId)
}

/** 激活标识（workspace/spec.md）：单 panel 无标识；双 active = bg-elevated + ring-1 accent + opacity 1；双 standby = opacity 0.5 hover 回升 0.78 */
const panelStateClass = computed(() => {
  if (props.active && props.isDual) {
    return 'bg-bg-elevated opacity-100 ring-1 ring-[var(--accent-ring)]'
  }
  if (!props.active && props.isDual) {
    return 'opacity-50 hover:opacity-[0.78]'
  }
  return ''
})
</script>
