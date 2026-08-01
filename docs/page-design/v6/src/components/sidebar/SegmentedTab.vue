<script setup lang="ts">
/** icon-only 5 tab 等宽均分。active=bg-bg-elevated text-neutral-fg（中性浮起）。
 *  对齐 v6-spec-sidebar.html §2 .seg / .seg-item。 */

import { computed } from 'vue'
import { sidebarTab, type SidebarTab } from '@/composables/useStore'
import { sessions, fileTree, subagents, workflows } from '@/mock/sessions'

interface TabDef {
  id: SidebarTab
  label: string
  /** lucide inner SVG markup */
  icon: string
  count: number
  running?: boolean
}

const tabs = computed<TabDef[]>(() => [
  {
    id: 'sessions',
    label: '会话',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    count: sessions.length,
  },
  {
    id: 'files',
    label: '文件',
    icon:
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    count: fileTree.filter((f) => f.gitStatus).length,
  },
  {
    id: 'subagents',
    label: '子智能体',
    icon:
      '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>',
    count: subagents.length,
    running: subagents.some((s) => s.status === 'running'),
  },
  {
    id: 'workflows',
    label: '工作流',
    icon:
      '<rect x="3" y="3" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/><path d="M9 6h6a2 2 0 0 1 2 2v7"/>',
    count: workflows.length,
    running: workflows.some((w) => w.status === 'running'),
  },
  {
    id: 'plugin',
    label: '插件',
    icon:
      '<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>',
    count: 2,
  },
])

function select(id: SidebarTab) {
  sidebarTab.value = id
}
</script>

<template>
  <div class="seg" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="sidebarTab === tab.id"
      :title="tab.label"
      class="seg-item"
      :class="{ 'seg-item--active': sidebarTab === tab.id }"
      @click="select(tab.id)"
    >
      <svg
        class="seg-item__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        v-html="tab.icon"
      />
      <span class="seg-item__count">{{ tab.count }}</span>
      <span
        v-if="tab.running"
        class="seg-item__badge"
        :class="{ 'seg-item__badge--pulse': tab.running }"
      ></span>
    </button>
  </div>
</template>

<style scoped>
.seg {
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  padding: 3px;
  display: flex;
  gap: 2px;
  margin: 0 4px 4px;
}
.seg-item {
  position: relative;
  flex: 1;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  background: transparent;
  border: 0;
  font-family: inherit;
  color: var(--neutral-mid);
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.seg-item:hover {
  color: var(--neutral-fg);
}
.seg-item__icon {
  width: 15px;
  height: 15px;
}
.seg-item__count {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  opacity: 0.7;
}
/* active：中性浮起 bg-bg-elevated text-neutral-fg */
.seg-item--active {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
}
.seg-item--active .seg-item__count {
  color: var(--neutral-mid);
  opacity: 1;
}
/* running badge：7px accent 圆点，右上角 */
.seg-item__badge {
  position: absolute;
  right: 6px;
  top: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.seg-item__badge--pulse {
  animation: pulse-accent 1.8s ease-in-out infinite;
}
@keyframes pulse-accent {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
@media (prefers-reduced-motion: reduce) {
  .seg-item__badge--pulse {
    animation: none;
  }
}
</style>
