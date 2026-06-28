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
      v-for="(leaf, i) in panel.panels"
      :key="leaf.id"
      :panel-id="leaf.id"
      :session-id="leaf.sessionId"
      :session-label="sessionLabelOf(leaf)"
      :session-dir="sessionDirOf(leaf)"
      :git-branch="gitBranchOf(leaf)"
      :status="statusOf(leaf)"
      :active="leaf.id === panel.activePanelId"
      :is-dual="panel.isDual"
      :is-first-panel="i === 0"
      @activate="panel.setActive"
      @split="onSplit"
      @new-session="onNewSession"
      @close="onClose(leaf.id)"
    />
  </div>
</template>

<script setup lang="ts">
import type { PanelLeaf } from '@xyz-agent/shared'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
import Panel from '@/components/panel/Panel.vue'

const panel = usePanelStore()
const session = useSessionStore()
const { derivedStatus, newSessionToStandby } = useSidebar()

// sidebar 选 session → panel 载入的编排在 useSidebar.selectSession（主路径）
// 与 AppShell watch(navigation.pointer)（⌘[/⌘] 同步），不在此组件 watch：
// 避免空态不渲染→watch 不注册→loadSession 不触发的初始化时序死锁。

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

/**
 * 新建会话（双 panel）：替换待机侧为新 session 并聚焦，active 侧 session 不动
 * （panel/spec.md 状态与交互）。编排在 useSidebar.newSessionToStandby。
 */
function onNewSession(): void {
  void newSessionToStandby()
}
function onClose(panelId: string): void {
  panel.close(panelId)
}
</script>

