<script setup lang="ts">
/**
 * Landing.vue —— 步骤1 落地空态（#2，§4.1/§4.5）。
 *
 * 渲染条件（NFR④#2 §3.8）：messageCount===0 && !isGenerating && state==='landing'。
 * 未 hydrate 时加 loading 占位防闪烁（AC-2.3）——骨架渲染条件接线点。
 *
 * 接线：读 useNewTaskFlow.state/gitInfo，触发 openDirPopover/openBranchPopover。
 * UC-7 守卫：gitInfo==null（非 git）时 branch chip 隐藏 + openBranchPopover 不可达（AC-2.2）。
 */
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'

defineProps<{
  /** 绑定的 session id（landing 态非 null，首次启动延迟 create 时为 null） */
  sessionId: string | null
}>()

const emit = defineEmits<{
  (e: 'compose'): void
}>()

const { state, gitInfo, openDirPopover, openBranchPopover } = useNewTaskFlow()

function onDirectoryChip(): void {
  openDirPopover()
}
function onBranchChip(): void {
  openBranchPopover()
}
function onCompose(): void {
  emit('compose')
}
</script>

<template>
  <!-- 骨架占位：完整 watermark + 问候语 + composer 元信息行属⑥Wave（spec §6） -->
  <div class="new-task-landing" :data-state="state">
    <button class="chip-dir" @click="onDirectoryChip">directory</button>
    <!-- UC-7：gitInfo==null（非 git）时隐藏 branch chip，openBranchPopover 不可达 -->
    <button v-if="gitInfo" class="chip-branch" @click="onBranchChip">{{ gitInfo.branch ?? 'branch' }}</button>
    <button class="compose" @click="onCompose">compose</button>
  </div>
</template>
