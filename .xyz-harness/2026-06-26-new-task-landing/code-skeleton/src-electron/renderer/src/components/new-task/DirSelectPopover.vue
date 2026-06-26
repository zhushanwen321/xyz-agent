<script setup lang="ts">
/**
 * DirSelectPopover.vue —— 步骤2 选目录 popover（#5，§4.2）。
 *
 * 数据流：openDirPopover 渲染 → recentWorkspaces(sessions) → 列表（空态 E4 文案）。
 * 选列表项 → emit('select', cwd)（useNewTaskFlow.selectWorkspace）；
 * 点「打开文件夹」→ useNewTaskFlow.openDirDialog（ipc.pickDirectory OS dialog）。
 */
import { computed } from 'vue'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { recentWorkspaces } from '@/lib/utils'
import { useSessionStore } from '@/stores/session'
import type { RecentWorkspace } from '@/lib/utils'

const props = defineProps<{
  /** 当前 cwd（高亮已选项） */
  currentCwd: string | null
}>()

const emit = defineEmits<{
  (e: 'select', cwd: string): void
}>()

const { openDirDialog } = useNewTaskFlow()
const session = useSessionStore()

/** recentWorkspaces top10（distinct cwd 倒序，AC-4.1/4.6） */
const workspaces = computed<RecentWorkspace[]>(() => recentWorkspaces(session.list.value))

function onSelect(ws: RecentWorkspace): void {
  emit('select', ws.cwd)
}
function onOpenFolder(): void {
  openDirDialog()
}
</script>

<template>
  <!-- 骨架占位：列表项 + 打开文件夹动作项属⑥Wave -->
  <div class="dir-select-popover">
    <p
      v-for="ws in workspaces"
      :key="ws.cwd"
      :data-current="ws.cwd === props.currentCwd"
      @click="onSelect(ws)"
    >{{ ws.cwd }}</p>
    <button class="open-folder" @click="onOpenFolder">打开文件夹</button>
  </div>
</template>
