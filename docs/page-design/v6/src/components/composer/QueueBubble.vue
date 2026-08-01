<script setup lang="ts">
/** QueueBubble · 排队队列指示器（v6 spec-input §8.5）
 *  - 内嵌 comp-box 顶部，border-b 分隔，融入 bg-input
 *  - 每条排队消息一行：Zap(steer=accent)/Clock(followup=info) icon + truncate 文本
 *  - 多条时显前 2-3 条 + 「+N」 */
import { computed } from 'vue'

interface QueueItem { type: 'steer' | 'followup'; text: string }

/** demo 静态数据：混排 steer/followup（5 条以触发 +N 溢出显示） */
const items = computed<QueueItem[]>(() => [
  { type: 'steer', text: '先处理这个：把 PanelHeader 的 border-b 去掉' },
  { type: 'steer', text: '顺手把 TurnMeta 的 hr 也删了' },
  { type: 'followup', text: '改完跑一下测试，确保没回归' },
  { type: 'steer', text: 'QueueBubble 的 +N 溢出也要验证' },
  { type: 'followup', text: '最后跑一遍 vue-tsc 检查类型' },
])
const maxShow = 3
const visible = computed(() => items.value.slice(0, maxShow))
const overflow = computed(() => Math.max(0, items.value.length - maxShow))
</script>

<template>
  <div class="qb-inline">
    <div v-for="(it, i) in visible" :key="i" class="qb-item">
      <!-- Zap=steer(accent) / Clock=followup(info)，13px stroke 1.75 -->
      <svg v-if="it.type === 'steer'" class="qb-ico steer" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>
      <svg v-else class="qb-ico followup" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      <span class="qb-text">{{ it.text }}</span>
    </div>
    <div v-if="overflow > 0" class="qb-more">+{{ overflow }}</div>
  </div>
</template>

<style scoped>
.qb-inline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid color-mix(in oklch, var(--border-strong) 50%, transparent);
}
.qb-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.qb-ico {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.qb-ico.steer { color: var(--accent); }
.qb-ico.followup { color: var(--info); }
.qb-text {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qb-more {
  padding-left: 25px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
</style>
