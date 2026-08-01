<script setup lang="ts">
/** ChangeSetCard · 变更集卡片（v6 spec-blocks §7）
 *  - bg-elevated 10px 圆角，无 border（浮在 main-panel surface 上）
 *  - 状态 badge 5 态彩色：accumulating/ready/partially-reviewed/resolved/superseded
 *  - collapsed：header only；expanded：文件列表（badge M/A/D/U + 文件名 + ±行数） */
import { computed, ref } from 'vue'

interface CsFile { name: string; badge: 'M' | 'A' | 'D' | 'U'; add: number; del: number }

const props = defineProps<{ data: Record<string, unknown> }>()
const status = computed(() => (props.data.status as string) || 'ready')
const title = computed(() => (props.data.title as string) || '变更集')
const count = computed(() => (props.data.count as number) ?? 0)
const stats = computed(() => props.data.stats as { add: number; del: number } | undefined)
const files = computed(() => (props.data.files as CsFile[]) || [])
const expanded = ref(props.data.state === 'expanded')

const statusLabel: Record<string, string> = {
  accumulating: '生成中',
  ready: '待审查',
  'partially-reviewed': '部分审查',
  resolved: '已解决',
  superseded: '已废弃',
}
</script>

<template>
  <div class="cs">
    <div class="cs-hd" @click="expanded = !expanded">
      <!-- chevron -->
      <svg class="cs-chev" :class="{ open: expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <!-- edit pencil icon -->
      <svg class="cs-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      <span class="cs-title">{{ title }}</span>
      <span class="cs-count">{{ count }}</span>
      <span class="cs-status" :class="status">{{ statusLabel[status] || status }}</span>
      <span v-if="stats" class="cs-stats">
        <span class="add">+{{ stats.add }}</span>
        <span class="del">-{{ stats.del }}</span>
      </span>
    </div>
    <div v-if="expanded" class="cs-detail">
      <div v-for="(f, i) in files" :key="i" class="cs-file">
        <span class="cs-fbadge" :class="f.badge">{{ f.badge }}</span>
        <span class="cs-fname">{{ f.name }}</span>
        <span v-if="f.add" class="fstat add">+{{ f.add }}</span>
        <span v-if="f.del" class="fstat del">-{{ f.del }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cs {
  margin-top: 8px;
  background: var(--bg-elevated);
  border-radius: 10px;
  overflow: hidden;
}
.cs-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
}
.cs-chev {
  width: 12px;
  height: 12px;
  color: var(--neutral-mid);
  flex-shrink: 0;
  transition: transform var(--duration-fast) var(--ease);
}
.cs-chev.open { transform: rotate(90deg); }
.cs-ico { width: 14px; height: 14px; color: var(--info); flex-shrink: 0; }
.cs-title {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--neutral-fg);
}
.cs-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--neutral-dim);
}
.cs-status {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.cs-status.accumulating { background: var(--accent-soft); color: var(--accent); }
.cs-status.ready { background: var(--info-soft); color: var(--info); }
.cs-status.partially-reviewed { background: var(--warn-soft); color: var(--warn); }
.cs-status.resolved { background: var(--success-soft); color: var(--success); }
.cs-status.superseded { background: var(--bg-elevated); color: var(--neutral-dim); }
.cs-stats {
  display: inline-flex;
  gap: 6px;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.cs-stats .add { color: var(--success); }
.cs-stats .del { color: var(--danger); }
.cs-detail { padding: 4px 0; }
.cs-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease);
}
.cs-file:hover { background: var(--surface-hover); }
.cs-fbadge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.cs-fbadge.M { background: var(--info-soft); color: var(--info); }
.cs-fbadge.A { background: var(--success-soft); color: var(--success); }
.cs-fbadge.D { background: var(--danger-soft); color: var(--danger); }
.cs-fbadge.U {
  background: color-mix(in oklch, var(--danger) 20%, transparent);
  color: var(--danger);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--danger) 40%, transparent);
}
.cs-fname {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fstat {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  flex-shrink: 0;
}
.fstat.add { color: var(--success); }
.fstat.del { color: var(--danger); }
</style>
