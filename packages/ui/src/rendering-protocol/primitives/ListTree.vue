<script setup lang="ts">
/**
 * 列表树组件（v6）——替代 TUI 的 ⎿ ├─ └─ 缩进。
 * 递归渲染 TreeItem：每项含 icon + label + 可选 status 圆点 + 可选 children。
 *
 * v6 改造（§3.4）：
 * - 缩进 depth × 16px padding-left（从 20px 收，留白档优于 border-l 引导线）。
 * - icon size-3(12px) 对齐 trace 档，去 statusClass 着色改中性（继承 label neutral-mid），
 *   状态信息全部由圆点承担（单一信息源，避免 icon 与 status 双重表达）。
 * - status 从文字标签改为 7px 圆点（done→bg-success / running→bg-accent / failed→bg-danger），
 *   margin-left:auto 右对齐（对齐 §3.3 状态指示范式）。
 * - 递归 depth 逻辑不变。
 */
import type { TreeItem, TreeItemIcon } from '@xyz-agent/extension-protocol'
import {
  ChevronRight, Check, X, Circle, Dot, Pause, GitBranch,
} from '@lucide/vue'
import type { Component } from 'vue'

const props = defineProps<{
  items: TreeItem[]
  /** 当前层深度（根层=0，递归 children 时 +1）。外部不需传，内部递归自动管理。 */
  depth?: number
}>()

const ICON_MAP: Record<TreeItemIcon, Component> = {
  arrow: ChevronRight,
  check: Check,
  cross: X,
  circle: Circle,
  dot: Dot,
  pause: Pause,
  branch: GitBranch,
}

/** v6：status → 圆点 bg 色（done=success / running=accent / failed=danger）。 */
const statusDotClass = (status?: TreeItem['status']) => {
  if (!status) return ''
  const map = { running: 'bg-accent', done: 'bg-success', failed: 'bg-danger' } as const
  return map[status]
}

const INDENT_PX = 16
const currentDepth = () => props.depth ?? 0
const depthPadding = () => ({ paddingLeft: `${currentDepth() * INDENT_PX}px` })
</script>

<template>
  <div class="list-tree font-mono text-[length:var(--text-sm)] leading-relaxed" data-testid="gui-list-tree">
    <template v-for="(item, i) in items" :key="i">
      <div class="list-tree__item flex items-center gap-1.5" :style="depthPadding()">
        <span class="list-tree__icon flex w-3.5 shrink-0 justify-center">
          <component
            v-if="item.icon"
            :is="ICON_MAP[item.icon]"
            class="size-3"
          />
        </span>
        <span class="text-neutral-mid">{{ item.label }}</span>
        <span
          v-if="item.status"
          data-testid="list-tree-status"
          class="list-tree__status ml-auto size-[7px] shrink-0 rounded-full"
          :class="statusDotClass(item.status)"
        />
      </div>
      <!-- 递归渲染 children：depth + 1 自动缩进 -->
      <template v-if="item.children && item.children.length > 0">
        <ListTree :items="item.children" :depth="currentDepth() + 1" />
      </template>
    </template>
  </div>
</template>
