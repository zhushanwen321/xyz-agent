<script setup lang="ts">
import { openSearch, sidebarCollapsed } from '@/composables/useStore'

/** PanelHeader：bg-elevated 浮起，status icon + breadcrumb + jsonl + git
 * 折叠态 chrome 迁入此 header（展开侧栏/后退/前进），与 AppNavControls 浮层位置一致 */

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}
</script>

<template>
  <header class="panel-header" :class="{ collapsed: sidebarCollapsed }">
    <!-- 折叠态 chrome（展开侧栏/后退/前进），位置同 AppNavControls 浮层（起 x=100px）-->
    <div v-if="sidebarCollapsed" class="collapsed-chrome">
      <button class="nav-btn" title="展开侧栏" @click="toggleSidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
      </button>
      <button class="nav-btn" title="后退">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      </button>
      <button class="nav-btn" title="前进">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
    </div>
    <!-- status icon（success check 绿色对勾）-->
    <svg class="status-ico" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/><polyline points="9 12 11 14 15 9"/>
    </svg>
    <!-- breadcrumb -->
    <div class="breadcrumb">
      <span class="dir">feat-optimize-ui</span>
      <span class="sep">▸</span>
      <span class="branch">main</span>
    </div>
    <div class="spacer"></div>
    <!-- jsonl 按钮 -->
    <button class="ph-btn jsonl-btn" title="jsonl">jsonl</button>
    <!-- history -->
    <button class="ph-btn" title="历史">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>
    </button>
    <!-- git -->
    <button class="ph-btn git-btn" title="Git" @click="openSearch()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
      <span class="dirty-dot"></span>
    </button>
  </header>
</template>

<style scoped>
.panel-header {
  height: 38px;
  flex-shrink: 0;
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
}
/* 折叠态：左侧留白让位 chrome（按钮起 x=100px，与 AppNavControls 浮层一致）*/
.panel-header.collapsed {
  padding-left: 88px;
}

/* 折叠态 chrome 按钮组（样式同 AppNavControls 的 nav-btn）*/
.collapsed-chrome {
  position: absolute;
  left: 100px;
  display: flex;
  gap: 2px;
}
.nav-btn {
  width: 26px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.nav-btn svg { width: 14px; height: 14px; }
.nav-btn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.nav-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}

.status-ico {
  width: 13px;
  height: 13px;
  color: var(--success);
  flex-shrink: 0;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  min-width: 0;
}
.breadcrumb .dir { color: var(--neutral-fg); font-weight: 600; }
.breadcrumb .sep { color: var(--neutral-faint); }
.breadcrumb .branch { color: var(--accent); font-size: var(--text-xs); }

.spacer { flex: 1; }

.ph-btn {
  width: 26px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-family: var(--font-mono);
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.ph-btn svg { width: 16px; height: 16px; }
.ph-btn:hover { background: var(--surface-hover); color: var(--neutral-fg); }

/* jsonl 按 spec 范式：height 20px / padding 0 4px / font-mono 11px / neutral-dim */
.jsonl-btn {
  width: auto;
  height: 20px;
  padding: 0 4px;
  font-weight: 500;
  color: var(--neutral-dim);
}

.git-btn { position: relative; }
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
</style>
