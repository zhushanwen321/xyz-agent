<script setup lang="ts">
/** PluginPanel：plugin tab 内容（sb-view 浮起层）。
 *  占位说明「plugin view 内容由 extension 注册」+ 几个 @zhushanwen/pi-* 占位卡片，
 *  每卡片用不同 icon（goal=target / todo=list-check / workflow=git-branch）。 */

type PluginIcon = 'target' | 'list' | 'workflow'

interface PluginCard {
  name: string
  desc: string
  icon: PluginIcon
}

const plugins: PluginCard[] = [
  { name: '@zhushanwen/pi-goal', desc: '目标管理与意图追踪', icon: 'target' },
  { name: '@zhushanwen/pi-todo', desc: '任务清单与进度追踪', icon: 'list' },
  { name: '@zhushanwen/pi-subagent-workflow', desc: '子 agent 工作流编排', icon: 'workflow' },
]
</script>

<template>
  <div class="plugin-panel">
    <div class="plugin-panel__hint">
      <svg
        class="plugin-panel__hint-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"
        />
      </svg>
      <span class="plugin-panel__hint-text">
        plugin view 内容由 extension 注册
      </span>
    </div>

    <div class="plugin-panel__list">
      <div v-for="p in plugins" :key="p.name" class="plugin-card">
        <!-- target icon（goal） -->
        <svg
          v-if="p.icon === 'target'"
          class="plugin-card__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
        </svg>
        <!-- list-check icon（todo） -->
        <svg
          v-else-if="p.icon === 'list'"
          class="plugin-card__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="3 7 4 8 6 6" />
          <polyline points="3 14 4 15 6 13" />
          <line x1="10" y1="7" x2="20" y2="7" />
          <line x1="10" y1="14" x2="20" y2="14" />
          <line x1="3" y1="20" x2="20" y2="20" />
        </svg>
        <!-- git-branch icon（workflow） -->
        <svg
          v-else
          class="plugin-card__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <div class="plugin-card__main">
          <div class="plugin-card__name">{{ p.name }}</div>
          <div class="plugin-card__desc">{{ p.desc }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-panel {
  /* sb-view 浮起层：surface 底色 + radius */
  background: var(--surface);
  border-radius: var(--radius);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.plugin-panel__hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 12px;
}
.plugin-panel__hint-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--neutral-dim);
}
.plugin-panel__hint-text {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}

.plugin-panel__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.plugin-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.plugin-card:hover {
  background: var(--surface-hover);
}
.plugin-card__icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--neutral-mid);
}
.plugin-card__main {
  min-width: 0;
  flex: 1;
}
.plugin-card__name {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.35;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-card__desc {
  margin-top: 1px;
  font-size: var(--text-2xs);
  line-height: 1.3;
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
