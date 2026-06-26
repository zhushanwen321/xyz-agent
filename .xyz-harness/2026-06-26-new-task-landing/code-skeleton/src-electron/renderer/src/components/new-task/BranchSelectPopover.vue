<script setup lang="ts">
/**
 * BranchSelectPopover.vue —— 步骤3 选分支 popover（#6，§4.3）。
 *
 * 数据流：openBranchPopover 渲染 → gitApi.status(sessionId) → GitStatusResult（含 dirty/分支列表）。
 * 选干净分支 → emit('select', name)（useNewTaskFlow.selectBranch）；
 * 选 dirty 分支 → inline 二次确认条（AC-6.2）→ emit('confirm-dirty', name)（confirmDirtySwitch）。
 * 点「创建并检出新分支」→ useNewTaskFlow.openBranchModal。
 * unborn HEAD（E7/AC-6.3）→ 空态文案。
 */
import { ref, onMounted } from 'vue'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { git as gitApi } from '@/api'
import type { GitStatusResult } from '@xyz-agent/shared'

const props = defineProps<{
  sessionId: string | null
}>()

const emit = defineEmits<{
  (e: 'select', name: string): void
  (e: 'confirm-dirty', name: string): void
}>()

const { openBranchModal } = useNewTaskFlow()

/** 分支列表 + dirty 标记（getStatus ~40-50ms 阻塞，NFR④#6 性能埋点在 runtime 侧） */
const status = ref<GitStatusResult | null>(null)

onMounted(async () => {
  if (!props.sessionId) return
  // [内] 真接线 gitApi.status；非 git/unborn HEAD → isRepo=false/空（E7）
  status.value = await gitApi.status(props.sessionId)
})

function onSelect(name: string): void {
  emit('select', name)
}
function onConfirmDirty(name: string): void {
  emit('confirm-dirty', name)
}
function onCreateBranch(): void {
  openBranchModal()
}
</script>

<template>
  <!-- 骨架占位：分支列表 + dirty 标记 + 二次确认条属⑥Wave -->
  <div class="branch-select-popover">
    <p class="current">{{ status?.branch ?? 'no-branch' }}</p>
    <button @click="onSelect('main')">main</button>
    <button @click="onConfirmDirty('feature')">feature(dirty)</button>
    <button @click="onCreateBranch">创建并检出新分支</button>
  </div>
</template>
