<script setup lang="ts">
/**
 * StatusBar（W3 · T2，C3 契约，S4 IF5 + clarify Q2/Q4 修订）——main-panel 局部底栏。
 *
 * 消费 S2 StatusBarController 聚合状态（per-session + global 两 scope，经注入
 * StatusBarSource），per-session 项在前 + global 项在后（IF5），同 scope 保持
 * controller 聚合顺序（组件不重排）。
 *
 * 自隐藏（clarify Q4 双级）：text 空串/纯空白的项不渲染（builtin statusline
 * 初始 text:'' 由 runtime 广播填充，填充前不可见）；两 scope 合并后无任何可渲染项
 * 时根元素 v-if 隐藏（不占位）。
 *
 * 命令执行（clarify Q2）：含 commandId 的项点击调 props.onCommand(commandId)，
 * 由父层（壳/P5）把 S2 IF6 CommandRegistry.execute 适配进来；无 commandId 项
 * 纯展示不可点击。
 *
 * 数据源经 inject 注入（STATUS_BAR_SOURCE_KEY），壳 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（design-review R3）。
 */
import { computed, inject } from 'vue'
import { STATUS_BAR_SOURCE_KEY, type StatusBarEntry } from './status-bar-source'

const props = withDefaults(
  defineProps<{
    /** 当前 sessionId；null 时跳过 per-session scope（仅渲染 global 项） */
    sessionId?: string | null
    /** 命令执行器（commandId → 执行），父层把 CommandRegistry.execute 适配进来 */
    onCommand?: (commandId: string) => void
  }>(),
  { sessionId: null, onCommand: undefined },
)

const source = inject(STATUS_BAR_SOURCE_KEY, null)

/** 两 scope 合并 + 空 text 项过滤（无状态自隐藏，clarify Q4） */
const visibleItems = computed<StatusBarEntry[]>(() => {
  if (!source) return []
  const hasText = (entry: StatusBarEntry) => entry.text.trim().length > 0
  const perSession = props.sessionId ? source.getItems('per-session', props.sessionId) : []
  const global = source.getItems('global')
  return [...perSession.filter(hasText), ...global.filter(hasText)]
})
</script>

<template>
  <div
    v-if="visibleItems.length > 0"
    data-testid="status-bar"
    class="flex h-7 items-center gap-2 border-t border-border bg-surface px-3 text-xs"
  >
    <span
      v-for="item in visibleItems"
      :key="item.id"
      data-testid="status-bar-item"
      :title="item.tooltip"
      class="text-muted-foreground"
      :class="[
        item.alignment === 'right' ? 'ml-auto' : '',
        item.commandId ? 'cursor-pointer hover:text-foreground' : '',
      ]"
      @click="item.commandId && onCommand?.(item.commandId)"
    >
      {{ item.text }}
    </span>
  </div>
</template>
