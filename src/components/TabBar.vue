<script setup lang="ts">
import type { ChatTab } from '../types'

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
  <div class="flex items-stretch bg-[#0a0a0b] border-b border-[#27272a] h-8 min-h-[32px] overflow-x-auto scrollbar-none">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="flex items-center gap-1.5 px-3 text-[11px] font-mono whitespace-nowrap relative transition-colors border-r border-[#27272a]"
      :class="tab.id === activeTabId
        ? 'text-[#fafafa] bg-[#111113]'
        : 'text-[#a1a1aa] bg-transparent hover:text-[#fafafa] hover:bg-[#18181b]'"
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
        class="absolute bottom-0 left-0 right-0 h-0.5 bg-[#22c55e]"
      />

      <!-- Close button -->
      <span
        v-if="tab.closable"
        class="inline-flex items-center justify-center w-3.5 h-3.5 text-[10px] rounded-sm text-[#71717a] ml-1 transition-colors hover:bg-[#1f1f23] hover:text-[#fafafa]"
        @click.stop="$emit('close', tab.id)"
      >✕</span>
    </button>
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
  border-left: 2px solid #22c55e;
  border-bottom: 2px solid #22c55e;
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
  background: #eab308;
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
  background: #22c55e;
  animation: s-pulse 1s ease-in-out infinite;
}
.s-streaming::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid #22c55e;
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
  border-top-color: #f97316;
  border-right-color: #f97316;
  animation: t-spin 0.8s linear infinite;
}

/* Failed — × 号 */
.s-failed::before, .s-failed::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 2px;
  background: #ef4444;
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
  background: #3b82f6;
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
