<script setup lang="ts">
/**
 * SideDrawer · 右侧抽屉容器
 * D2 一体化：与 main 共享 surface，去 border-l，仅 shadow-drawer 弱投影分隔。
 * L1 icon tab 栏（bg 浮起分层，去 border-b），active=bg-elevated。
 * 宽度由父级 flex:1 与 workspace 等分（1:1），本组件作 flex 子项。
 */
import { ref } from 'vue'
import {
  drawerTab,
  drawerOpen,
  type DrawerTab,
} from '@/composables/useStore'
import TerminalView from './TerminalView.vue'
import BrowserPane from './BrowserPane.vue'
import GitPanel from './GitPanel.vue'
import CommandDocPanel from './CommandDocPanel.vue'
import DetailPane from './DetailPane.vue'
import SubagentTab from './SubagentTab.vue'
import WorkflowTab from './WorkflowTab.vue'

/** L1 icon tab 配置（terminal/browser/git/doc/detail/subagent/workflow） */
interface L1Tab {
  id: DrawerTab
  title: string
  /** inline svg path d（lucide 24×24，stroke-width 1.75） */
  paths: string
}

const l1Tabs: L1Tab[] = [
  { id: 'terminal', title: 'terminal', paths: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
  { id: 'browser', title: 'browser', paths: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
  { id: 'git', title: 'git', paths: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>' },
  { id: 'doc', title: 'doc（命令/skill 文档）', paths: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' },
  { id: 'detail', title: 'detail（文件预览）', paths: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
  { id: 'subagent', title: 'subagent（嵌套只读对话流）', paths: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>' },
  { id: 'workflow', title: 'workflow（agent call 列表）', paths: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>' },
]

/** 钉住态（demo 本地状态） */
const pinned = ref(true)
</script>

<template>
  <aside class="sd-drawer">
    <!-- L1 icon tab 栏（bg 浮起分层，去 border-b）-->
    <div class="sd-l1">
      <button
        v-for="t in l1Tabs"
        :key="t.id"
        class="l1-icon"
        :class="{ on: drawerTab === t.id }"
        :title="t.title"
        @click="drawerTab = t.id"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" v-html="t.paths" />
      </button>

      <span class="sd-unread" title="drawer 打开期间 agent 新消息">
        <span class="pulse-dot"></span><span class="count">3</span>
      </span>

      <span class="spacer"></span>

      <button
        class="l1-act"
        :class="{ pinned }"
        :title="pinned ? '取消钉住（当前已钉住）' : '钉住抽屉'"
        @click="pinned = !pinned"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="17" x2="12" y2="22" />
          <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
        </svg>
      </button>
      <button class="l1-act" title="关闭抽屉" @click="drawerOpen = false">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <!-- body：按 L1 tab 切换内容 -->
    <div class="sd-body">
      <TerminalView v-if="drawerTab === 'terminal'" />
      <BrowserPane v-else-if="drawerTab === 'browser'" />
      <GitPanel v-else-if="drawerTab === 'git'" />
      <CommandDocPanel v-else-if="drawerTab === 'doc'" />
      <DetailPane v-else-if="drawerTab === 'detail'" />
      <SubagentTab v-else-if="drawerTab === 'subagent'" />
      <WorkflowTab v-else-if="drawerTab === 'workflow'" />
    </div>
  </aside>
</template>

<style scoped>
/* D2 一体化：与 main 同色 surface，去 border-l，弱投影分隔，无自带圆角（在 main 圆角外壳内）。 */
.sd-drawer {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  box-shadow: var(--shadow-drawer);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* L1 icon tab 栏：surface-2 浮起分层（去 border-b，§3.4）*/
.sd-l1 {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: var(--surface-2);
  flex-shrink: 0;
}

.sd-l1 .l1-icon {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-mid);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--ease);
  flex-shrink: 0;
}
.sd-l1 .l1-icon:hover {
  color: var(--neutral-fg);
  background: var(--surface-hover);
}
.sd-l1 .l1-icon.on {
  color: var(--neutral-fg);
  background: var(--bg-elevated);
}
.sd-l1 .l1-icon.on:hover {
  color: var(--neutral-fg);
  background: var(--bg-elevated);
}

.sd-l1 .spacer {
  flex: 1;
}

.sd-l1 .l1-act {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--ease);
  flex-shrink: 0;
}
.sd-l1 .l1-act.pinned {
  color: var(--accent);
}
.sd-l1 .l1-act:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.sd-l1 .l1-act.pinned:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

/* unread badge：脉动蓝点 + 计数 */
.sd-unread {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
}
.sd-unread .pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--neutral-fg);
  animation: sd-pulse 1.8s ease-in-out infinite;
}
.sd-unread .count {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-fg);
}
@keyframes sd-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.sd-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
