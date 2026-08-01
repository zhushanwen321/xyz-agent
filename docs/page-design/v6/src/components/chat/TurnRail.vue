<script setup lang="ts">
/** TurnRail · 对话流 turn 导航 rail（v6 spec IF4，demo 适配版）
 *  - 常驻右侧窄条（6px spine），hover 弹出全 turn 列表浮层（mini-map + 快速跳转）
 *  - 窄条上有 viewport indicator 标记当前 turn 在窄条上的纵向位置
 *  - 浮层内每个节点两行：user 行（User 图标 + user 文本）+ agent 行（状态图标 + agent 摘要）
 *  - 状态融入 agent 行图标颜色（failed 哑光金 warn 常驻 / 进行中 accent + spin / 完成中性灰 ico）
 *  - toggle 按钮 hover 浮出（渐进披露），active 节点常驻可见
 *  - demo 版：去掉 useMessageStreamRail / i18n / Button / lucide 依赖，用静态 mock + 纯 CSS hover + inline svg
 *  - 数据从 chatTurns mock 派生（active = 最后一个 turn = streaming 态），demo 写死一个 failed 节点演示 warn 着色 */
import { computed, ref } from 'vue'
import { chatTurns } from '@/mock/sessions'

interface RailNode {
  user: string
  summary: string
  status: 'done' | 'active' | 'failed'
}

/** 从 chatTurns 派生 rail 节点（demo）：最后一条 = active streaming；其余 done。
 *  手动把第 2 条标 failed 演示 warn 常驻色（rail 是全局导航，一眼可辨失败位置）。 */
const nodes = computed<RailNode[]>(() =>
  chatTurns.map((turn, idx) => {
    const isLast = idx === chatTurns.length - 1
    const thinkCount = turn.blocks.filter((b) => b.type === 'thinking').length
    const toolCount = turn.blocks.filter((b) => b.type === 'tool' || b.type === 'bash').length
    return {
      user: turn.userMessage,
      summary: isLast
        ? '进行中…'
        : `${thinkCount} thoughts · ${toolCount} tools`,
      status: idx === 1 ? 'failed' : isLast ? 'active' : 'done',
    }
  }),
)

/** active = 唯一 active 节点（streaming 中最后一个） */
const activeIndex = computed(() => nodes.value.findIndex((n) => n.status === 'active'))

/** viewport indicator 纵向定位（比例位置 + 比例高度） */
const viewportStyle = computed(() => {
  const total = nodes.value.length || 1
  const topPct = (activeIndex.value / total) * 100
  const heightPct = 100 / total
  return { top: `${topPct}%`, height: `${heightPct}%` }
})

/** demo：toggle 演示（点击节点 toggle 切换展开态图标方向，无真实副作用） */
const expanded = ref<Set<number>>(new Set())
function isExpanded(idx: number) {
  return expanded.value.has(idx)
}
function toggle(idx: number, ev: Event) {
  ev.stopPropagation()
  if (expanded.value.has(idx)) expanded.value.delete(idx)
  else expanded.value.add(idx)
  // 触发响应式更新
  expanded.value = new Set(expanded.value)
}

/** user 行摘要：截断 user 文本前 32 字（rail 列宽有限） */
function userSummary(text: string) {
  return text.length > 32 ? text.slice(0, 32) + '…' : text
}
</script>

<template>
  <div v-if="nodes.length" class="turn-rail" data-testid="turn-rail">
    <!-- 常驻窄条 spine：未 hover 时唯一可见区域（L1 入口可发现性） -->
    <div class="rail-spine" />

    <!-- viewport indicator：标记当前 turn 在窄条上的纵向位置（mini-map 高亮） -->
    <div class="rail-viewport" :style="viewportStyle" />

    <!-- hover 展开浮层（常驻 DOM，靠 :hover 切换可见性，避免动画抖动）。
         bg-elevated（浮起面板语义）+ ring 硬边界（不依赖阴影方向） -->
    <div class="rail-panel">
      <div class="rail-list">
        <div
          v-for="(node, idx) in nodes"
          :key="idx"
          class="rail-node"
          :class="{ active: idx === activeIndex }"
          data-testid="rail-node"
        >
          <!-- user 行：User 图标（neutral-ico）+ user 文本（neutral-fg） -->
          <div class="row user-row">
            <svg class="row-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span class="row-text user-text">{{ userSummary(node.user) }}</span>
          </div>
          <!-- agent 行：状态图标（failed=warn 常驻 / active=accent spin / done=neutral-ico）+ agent 摘要 -->
          <div class="row agent-row">
            <!-- active 态：双环 loader-spin（accent 蓝，微缩） -->
            <svg
              v-if="node.status === 'active'"
              class="row-ico spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            ><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
            <!-- 非 active 态：Bot 图标（failed=warn 常驻 / done=neutral-ico） -->
            <svg
              v-else
              class="row-ico"
              :class="{ warn: node.status === 'failed' }"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            ><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/></svg>
            <span
              class="row-text agent-text"
              :class="{ failed: node.status === 'failed' }"
            >{{ node.summary }}</span>
          </div>
          <!-- 折展 toggle 按钮：hover/focus 浮出（渐进披露），active 节点常驻可见 -->
          <button
            class="rail-toggle"
            :class="{ 'always-on': idx === activeIndex }"
            data-testid="rail-toggle"
            :data-expanded="isExpanded(idx)"
            title="折叠/展开该 turn"
            @click="toggle(idx, $event)"
          >
            <!-- ChevronUp=展开态 / ChevronDown=折叠态 -->
            <svg v-if="isExpanded(idx)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turn-rail {
  /* 贴右缘 + 垂直居中，高度 340px 对齐真实组件；hover 展宽 */
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  width: 6px;
  height: 340px;
  z-index: var(--z-sticky);
  transition: width var(--duration) var(--ease);
}
.turn-rail:hover { width: 224px; }

/* spine：6px 窄条，bg-surface-hover 保证在 bg 上明确可见 */
.rail-spine {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 6px;
  border-radius: 9999px;
  background: var(--surface-hover);
}

/* viewport indicator：accent 高亮当前 turn 在窄条上的纵向位置 */
.rail-viewport {
  position: absolute;
  left: 0;
  width: 6px;
  border-radius: 9999px;
  border-left: 2px solid var(--accent);
  background: var(--accent-soft);
}

/* hover 展开浮层：bg-elevated（浮起面板语义）+ ring 硬边界。
   平时 translate-x + opacity-0 + pointer-events-none，hover 切可见 */
.rail-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 12px;
  right: 0;
  padding: var(--space-2);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-2);
  outline: 1px solid var(--border-strong);
  transform: translateX(8px);
  opacity: 0;
  pointer-events: none;
  transition: transform var(--duration) var(--ease), opacity var(--duration) var(--ease);
}
.turn-rail:hover .rail-panel {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}

/* 节点列表（铺满浮层，超出靠浮层自身滚动） */
.rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 100%;
  overflow-y: auto;
}

/* 单个节点 */
.rail-node {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-1) 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.rail-node:hover { background: var(--surface-hover); }
.rail-node.active {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-ring);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.row-ico {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--neutral-ico);
}
.row-ico.warn { color: var(--warn); }
.row-ico.spin { color: var(--accent); animation: spin 1s linear infinite; }
.row-text {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 24px; /* 给 toggle 按钮留位 */
}
.user-text { color: var(--neutral-fg); }
.agent-text { color: var(--neutral-mid); }
.agent-text.failed {
  color: var(--neutral-mid);
  transition: color var(--duration-fast) var(--ease);
}
.agent-text.failed:hover { color: var(--neutral-fg); }

/* 折展 toggle 按钮：hover/focus 浮出（渐进披露），active 节点常驻可见 */
.rail-toggle {
  position: absolute;
  top: 50%;
  right: 4px;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: translateY(-50%);
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.rail-toggle svg { width: 12px; height: 12px; }
.rail-node:hover .rail-toggle,
.rail-node:focus-within .rail-toggle,
.rail-toggle.always-on { opacity: 1; }
.rail-toggle:hover { background: var(--surface-hover); color: var(--neutral-fg); }

@keyframes spin { to { transform: rotate(360deg); } }
</style>
