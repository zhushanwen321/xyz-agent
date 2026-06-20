<template>
  <!--
    容器组件 · PanelContainer（workspace/spec.md Panel 挂载点 + split 状态机）。
    读 panel store：单 panel 渲染 1 个 Panel（撑满），双 panel 渲染 2 个（主从）。
    双 panel 中缝用 gap + bg-border 实现（draft-dual-panel workspace-body 同款）。
    active panel 的 sessionId 跟随 session store.activeId（sidebar 选 session → 载入 active panel）。
    v1：双 panel 的第二 session 来源 G-023 DEFERRED，standby panel 暂显空态占位。
  -->
  <div
    class="panel-container relative flex min-h-0 flex-1"
    :class="panel.isDual ? 'gap-px bg-border' : ''"
  >
    <Panel
      v-for="leaf in panel.panels"
      :key="leaf.id"
      :panel-id="leaf.id"
      :session-label="sessionLabelOf(leaf)"
      :session-dir="sessionDirOf(leaf)"
      :git-branch="gitBranchOf(leaf)"
      :status="statusOf(leaf)"
      :active="leaf.id === panel.activePanelId"
      :is-dual="panel.isDual"
      @activate="panel.setActive"
      @split="onSplit"
      @close="onClose(leaf.id)"
      @diff="onDiff"
    />
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import type { PanelLeaf } from '@xyz-agent/shared'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
import Panel from '@/components/panel/Panel.vue'

const panel = usePanelStore()
const session = useSessionStore()
const { derivedStatus } = useSidebar()

/** sidebar 选 session → 自动载入 active panel（单 panel 默认根节点）。
 * 首次有 session 时也激活 panel（无 session 则 panel 空态）。
 */
watch(
  () => session.activeId,
  (sid) => {
    if (!sid) return
    // session 已在某 panel 则只切焦点，否则载入当前 active panel
    const existing = panel.findPanelBySession(sid)
    if (existing) {
      panel.setActive(existing.id)
    } else {
      panel.loadSession(panel.activePanelId, sid)
    }
  },
)

function sessionLabelOf(leaf: PanelLeaf): string {
  return leaf.sessionId ? session.list.find((s) => s.id === leaf.sessionId)?.label ?? '' : ''
}
function sessionDirOf(leaf: PanelLeaf): string {
  return leaf.sessionId ? session.list.find((s) => s.id === leaf.sessionId)?.cwd ?? '' : ''
}
function gitBranchOf(leaf: PanelLeaf): string | undefined {
  return leaf.sessionId ? session.list.find((s) => s.id === leaf.sessionId)?.gitBranch : undefined
}
function statusOf(leaf: PanelLeaf) {
  return leaf.sessionId ? derivedStatus(leaf.sessionId).value : 'done'
}

function onSplit(): void {
  panel.split()
}
function onClose(panelId: string): void {
  panel.close(panelId)
}
function onDiff(): void {
  // diff 抽屉属 Side Drawer（G-023/G detail-pane），DEFERRED，v1 空实现
}
</script>

