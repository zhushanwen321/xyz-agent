<script setup lang="ts">
/** TurnMeta · turn 元信息行（v6 spec-container §3）
 *  - ghost 文字行（无 bg/radius），label + elapsed + tm-pill（thinking/tool 计数）
 *  - demo 显 done 态 + 「思考中」streaming 态两种渲染（按 streaming prop） */
import { computed } from 'vue'
import type { ChatBlock } from '@/mock/sessions'

const props = defineProps<{ blocks: ChatBlock[]; streaming?: boolean }>()

const thinkCount = computed(() => props.blocks.filter(b => b.type === 'thinking').length)
const toolCount = computed(() => props.blocks.filter(b => b.type === 'tool' || b.type === 'bash').length)
const elapsed = computed(() => (props.streaming ? '12.3s' : '8.1s'))
</script>

<template>
  <div class="tm">
    <!-- streaming：accent spinner + 「思考中」 -->
    <svg v-if="streaming" class="tm-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
    <span class="tm-label" :class="{ streaming }">{{ streaming ? '思考中' : '已工作' }}</span>
    <span class="tm-elapsed">{{ elapsed }}</span>
    <span v-if="thinkCount" class="tm-pill">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/></svg>
      think · {{ thinkCount }}
    </span>
    <span v-if="toolCount" class="tm-pill">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15c1.06 0 2-.6 3-2 1-1.4 1.94-2 3-2"/><path d="M9 9c1.06 0 2-.6 3-2 1-1.4 1.94-2 3-2"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
      tool · {{ toolCount }}
    </span>
    <!-- chevron 在最末（spec：label → elapsed → pill → chev） -->
    <svg v-if="!streaming" class="tm-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  </div>
</template>

<style scoped>
.tm {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 10px;
  padding: 4px;
  font-size: var(--text-sm);
  font-weight: 500;
}
.tm-spinner {
  width: 12px;
  height: 12px;
  color: var(--accent);
  flex-shrink: 0;
  animation: spin 1s linear infinite;
}
.tm-label { color: var(--neutral-mid); }
.tm-label.streaming { color: var(--accent); }
.tm-chev {
  width: 9px;
  height: 9px;
  color: var(--neutral-dim);
  flex-shrink: 0;
  transition: color var(--duration-fast) var(--ease);
}
.tm-chev:hover { color: var(--neutral-fg); }
.tm-elapsed {
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--neutral-fg);
}
.tm-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 9999px;
  background: var(--bg-elevated);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--neutral-mid);
}
.tm-pill svg { width: 10px; height: 10px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
