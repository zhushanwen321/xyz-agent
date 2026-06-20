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
    class="panel relative flex min-w-0 flex-1 flex-col overflow-hidden"
    :class="{ 'panel--active': active, 'panel--standby': !active && isDual }"
    @mousedown="onPanelMouseDown"
  >
    <PanelHeader
      :session-label="sessionLabel"
      :session-dir="sessionDir"
      :status="status"
      :active="active"
      :is-dual="isDual"
      @split="emit('split')"
      @close="emit('close')"
    />

    <!-- ② message-stream 占位（FG5 MessageStream.vue 替换） -->
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <MessageSquare class="size-6 text-subtle opacity-40" />
      <p class="text-[12px] text-subtle opacity-70">
        {{ sessionLabel ? '消息流待 FG5 实现' : '选择左侧会话开始' }}
      </p>
    </div>

    <!-- ③ progress-zone（composer 上方） -->
    <ProgressZone :session-label="sessionLabel" />

    <!-- ④ composer 占位（FG5 Composer.vue 替换） -->
    <div v-if="sessionLabel" class="mx-3.5 flex-shrink-0">
      <div class="flex items-center gap-2 rounded-lg border border-border bg-black/20 px-3 py-2.5">
        <span class="text-[13px] text-subtle opacity-60">输入区待 FG5 实现…</span>
        <Button variant="default" size="icon" class="ml-auto size-[30px] rounded-md bg-accent" disabled>
          <ArrowRight class="size-[15px]" />
        </Button>
      </div>
    </div>

    <!-- ⑤ git-zone（composer 下方） -->
    <GitZone :git-branch="gitBranch" @diff="emit('diff')" />
  </section>
</template>

<script setup lang="ts">
import { MessageSquare, ArrowRight } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import type { DerivedStatus } from '@/types'
import PanelHeader from './PanelHeader.vue'
import ProgressZone from './ProgressZone.vue'
import GitZone from './GitZone.vue'

const props = defineProps<{
  panelId: string
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
</script>

<style scoped>
/* 四层激活标识（workspace/spec.md）：
   - 单 panel：无标识，正常显示（opacity 1，无 ring）
   - 双 panel active：左 2px accent 竖条 + inset accent-ring + bg-elevated 浮起 + opacity 1
   - 双 panel standby：opacity 0.5，hover 回升 0.78 */
.panel {
  transition: background var(--duration) var(--ease),
              opacity var(--duration) var(--ease),
              box-shadow var(--duration) var(--ease);
}
.panel--standby {
  opacity: 0.5;
}
.panel--standby:hover {
  opacity: 0.78;
}
.panel--active {
  background: var(--surface-hover);
  opacity: 1;
  box-shadow: inset 0 0 0 1px rgba(79, 142, 247, 0.3);
}
/* 左侧焦点竖条（独立层 ::before，避免被 ring 盖住） */
.panel--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
  z-index: 6;
}
</style>
