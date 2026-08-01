<script setup lang="ts">
/** TurnSummary · assistant 回复底部收尾（v6 spec-content §12.6）
 *  - done 态：neutral-fg + 3 个 hover action（copy/fork/handoff ghost icon 24px）
 *  - streaming 态：neutral-mid + blink cursor
 *  - actions opacity-0 → hover/focus-within opacity-100（hover 域 = 整个 assistant turn，由 MessageStream .ms-assistant-col:hover 驱动）
 *  - 点击 fork/handoff = 进入「+Q 变体」（composer 出 staging chip + 聚焦输入），emit 给父级编排
 *  - subagent 变体（spec 帧⑦）：仅 copy，无 fork/handoff——关键权限差异 */
import { ref } from 'vue'

withDefaults(defineProps<{ text: string; streaming?: boolean; variant?: 'normal' | 'subagent' }>(), {
  variant: 'normal',
})
const emit = defineEmits<{ (e: 'fork'): void; (e: 'handoff'): void }>()
const copied = ref(false)
function onCopy() {
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
function onFork() { emit('fork') }
function onHandoff() { emit('handoff') }
</script>

<template>
  <div class="ts-wrap" :class="{ streaming }">
    <div class="ts-summary">
      {{ text }}<span v-if="streaming" class="ts-cursor"></span>
    </div>
    <div v-if="!streaming" class="ts-actions">
      <button class="ts-ghost" :class="{ copied }" :title="copied ? '已复制' : 'copy（复制）'" @click="onCopy">
        <!-- copied → Check success，否则 Copy -->
        <svg v-if="copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      </button>
      <button v-if="variant !== 'subagent'" class="ts-ghost fork" title="fork（fork 后台 · 默认 +Q 带提问）" @click="onFork">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>
      </button>
      <button v-if="variant !== 'subagent'" class="ts-ghost handoff" title="handoff（交接 · 默认 +Q 带提问）" @click="onHandoff">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 14"/><path d="m7 18 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"/><path d="m2 13 6 6"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ts-wrap {
  padding-top: 12px;
  font-size: var(--text-base);
  line-height: 1.75;
  transition: color 200ms var(--ease);
}
.ts-wrap.streaming { color: var(--neutral-mid); }
.ts-wrap:not(.streaming) { color: var(--neutral-fg); }
.ts-summary { font-size: var(--text-base); line-height: 1.75; white-space: pre-wrap; }
.ts-cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  border-radius: 1px;
  background: var(--accent);
  vertical-align: middle;
  margin-left: 2px;
  animation: blink 1s step-end infinite;
}
.ts-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity 150ms var(--ease);
}
.ts-wrap:hover .ts-actions,
.ts-wrap:focus-within .ts-actions { opacity: 1; }
.ts-ghost {
  position: relative;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.ts-ghost svg { width: 13px; height: 13px; }
.ts-ghost:hover { background: var(--surface-hover); color: var(--neutral-fg); }
.ts-ghost.fork:hover,
.ts-ghost.handoff:hover { background: var(--accent-soft); color: var(--accent); }
.ts-ghost.copied { color: var(--success); }
.ts-ghost.copied:hover { background: var(--success-soft); color: var(--success); }
.ts-ghost.disabled { opacity: 0.5; pointer-events: none; }
@keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
</style>
