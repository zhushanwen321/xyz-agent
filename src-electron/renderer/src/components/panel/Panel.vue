<template>
  <!--
    容器组件 · Panel（panel/spec.md 5 zone 编排，承载一个 Session）。
    自上而下：① panel-header → ② message-stream → ③ progress-zone → ④ composer → ⑤ git-zone。
    FG4 骨架：①③⑤ 用 zone 空壳；②④（MessageStream/Composer）属 FG5，v1 用占位区。
    四层激活标识（workspace/spec.md，单 panel 无标识、双 panel active 才有）：
    左 2px accent 竖条 + inset accent-ring + bg-elevated 浮起 + 非激活 opacity 0.5。
    点击 panel body 切 active（主从焦点，非按钮区域）。
  -->
  <section
    class="relative flex min-w-0 flex-1 flex-col overflow-hidden transition-[background-color,opacity,box-shadow] duration-[var(--duration)] ease-[var(--ease)]"
    :class="panelStateClass"
    @mousedown="onPanelMouseDown"
  >
    <!-- 左侧焦点竖条（双 panel active，workspace/spec.md 四层激活之一。原 ::before 改 div 避免 scoped 伪元素） -->
    <div v-if="active && isDual" class="absolute left-0 top-0 bottom-0 z-[6] w-[2px] bg-accent" />
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

    <!-- ③④⑤ companion zones：progress / composer / git 垂直 6px 紧凑成「带」（draft-companion-zones §裁决）。
         三 zone 共享卡片语言、各自独立成卡；统一容器管垂直间距，移除各自 margin。 -->
    <div class="composer-band flex flex-shrink-0 flex-col gap-1.5">
      <!-- ③ progress-zone（composer 上方） -->
      <ProgressZone phase="running" />

      <!-- ④ composer（FG5，S1/S2/S5/S6 主路径） -->
      <Composer v-if="sessionId" :session-id="sessionId" />

      <!-- ⑤ git-zone（composer 下方） -->
      <GitZone :git-branch="gitBranch" @diff="emit('diff')" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquare } from '@lucide/vue'
import type { DerivedStatus } from '@/types'
import PanelHeader from './PanelHeader.vue'
import ProgressZone from './ProgressZone.vue'
import GitZone from './GitZone.vue'
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
  diff: []
}>()

/** 点击 panel body 切 active（双 panel 主从焦点）；点 header 按钮不误切（按钮自身 stopPropagation） */
function onPanelMouseDown(e: MouseEvent): void {
  if (!props.isDual || props.active) return
  // 按钮点击由 reka-ui/Button 内部处理，这里检查最近 button 祖先避免误切
  if ((e.target as HTMLElement).closest('button')) return
  emit('activate', props.panelId)
}

/** 四层激活标识（workspace/spec.md）：单 panel 无标识；双 active = bg-elevated + inset accent-ring + opacity 1；双 standby = opacity 0.5 hover 回升 0.78 */
const panelStateClass = computed(() => {
  if (props.active && props.isDual) {
    return 'bg-bg-elevated opacity-100 shadow-[inset_0_0_0_1px_var(--accent-ring)]'
  }
  if (!props.active && props.isDual) {
    return 'opacity-50 hover:opacity-[0.78]'
  }
  return ''
})
</script>
