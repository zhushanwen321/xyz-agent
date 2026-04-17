<script setup lang="ts">
import type { ChatTab } from '../types'
import { Button } from '@/components/ui/button'

defineProps<{
  tabs: ChatTab[]
  activeTabId: string
}>()

defineEmits<{
  switch: [tabId: string]
  close: [tabId: string]
}>()
</script>

<template>
  <div class="flex items-stretch bg-base border-b border-border-default h-8 min-h-[32px] overflow-x-auto scrollbar-none">
    <Button
      v-for="tab in tabs"
      :key="tab.id"
      variant="ghost"
      size="sm"
      class="flex items-center gap-1.5 px-3 text-[11px] font-mono whitespace-nowrap relative border-r border-border-default rounded-t-[length:var(--radius)]"
      :class="tab.id === activeTabId
        ? 'text-foreground bg-surface'
        : 'text-muted-foreground bg-transparent hover:text-foreground hover:bg-card'"
      @click="$emit('switch', tab.id)"
    >
      <!-- Status icon -->
      <span class="tab-icon" :class="'s-' + tab.status">
        <template v-if="tab.status === 'thinking'">
          <span class="dot" /><span class="dot" /><span class="dot" />
        </template>
      </span>

      <!-- Title -->
      <span>{{ tab.title }}</span>

      <!-- Active indicator -->
      <span
        v-if="tab.id === activeTabId"
        class="absolute bottom-0 left-0 right-0 h-0.5 bg-semantic-green"
      />

      <!-- Close button -->
      <span
        v-if="tab.closable"
        class="inline-flex items-center justify-center w-3.5 h-3.5 text-[10px] rounded-sm text-tertiary ml-1 transition-colors hover:bg-inset hover:text-foreground"
        @click.stop="$emit('close', tab.id)"
      >✕</span>
    </Button>
  </div>
</template>

<style scoped>
.scrollbar-none::-webkit-scrollbar { display: none; }
.scrollbar-none { scrollbar-width: none; }

/* Tab status icons */
.tab-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

/* Completed — 对勾 */
.s-completed::after {
  content: '';
  width: 8px;
  height: 5px;
  border-left: 2px solid var(--semantic-green);
  border-bottom: 2px solid var(--semantic-green);
  transform: rotate(-45deg) translateY(-1px);
}

/* Thinking — 脉冲圆点 */
.s-thinking {
  gap: 2px;
}
.s-thinking .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--semantic-yellow);
  animation: thinking-dots 1.4s ease-in-out infinite;
}
.s-thinking .dot:nth-child(2) { animation-delay: 0.2s; }
.s-thinking .dot:nth-child(3) { animation-delay: 0.4s; }

/* Streaming — 实心圆 + 扩散环 */
.s-streaming::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--semantic-green);
  animation: s-pulse 1s ease-in-out infinite;
}
.s-streaming::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--semantic-green);
  animation: s-ring 1.5s ease-out infinite;
  opacity: 0;
}

/* Tool call — 旋转弧线 */
.s-tool::before {
  content: '';
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: var(--semantic-orange);
  border-right-color: var(--semantic-orange);
  animation: t-spin 0.8s linear infinite;
}

/* Failed — × 号 */
.s-failed::before, .s-failed::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 2px;
  background: var(--semantic-red);
  border-radius: 1px;
}
.s-failed::before { transform: rotate(45deg); }
.s-failed::after { transform: rotate(-45deg); }

/* Idle — 实心圆 */
.s-idle::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--semantic-blue);
}

@keyframes thinking-dots {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.2); }
}
@keyframes s-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
@keyframes s-ring {
  0% { transform: scale(0.8); opacity: 0.8; }
  100% { transform: scale(1.6); opacity: 0; }
}
@keyframes t-spin {
  to { transform: rotate(360deg); }
}
</style>
