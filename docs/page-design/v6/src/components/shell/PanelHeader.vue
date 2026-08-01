<script setup lang="ts">
import { openSearch } from '@/composables/useStore'

/** PanelHeader：bg-elevated 浮起，status icon + breadcrumb + jsonl + git */
</script>

<template>
  <header class="panel-header">
    <!-- status icon（success check 绿色对勾）-->
    <svg class="status-ico" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/><polyline points="9 12 11 14 15 9"/>
    </svg>
    <!-- breadcrumb -->
    <div class="breadcrumb">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="dir">feat-optimize-ui</span>
      <span class="sep">›</span>
      <span class="branch">visual-modernization</span>
    </div>
    <div class="spacer"></div>
    <!-- jsonl 按钮 -->
    <button class="ph-btn jsonl-btn" title="a3f2c9.jsonl">a3f2c9.jsonl</button>
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

.status-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-ico);
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
.breadcrumb .branch { color: var(--neutral-mid); }

.spacer { flex: 1; }

.ph-btn {
  height: 26px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  font-size: var(--text-2xs);
  font-family: var(--font-mono);
  transition: all var(--duration-fast) var(--ease);
}
.ph-btn svg { width: 14px; height: 14px; }
.ph-btn:hover { background: var(--surface-hover); color: var(--neutral-fg); }

.jsonl-btn { font-weight: 500; }

.git-btn { position: relative; }
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
</style>
