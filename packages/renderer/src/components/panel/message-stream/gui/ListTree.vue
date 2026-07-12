<script setup lang="ts">
/**
 * 列表树组件——替代 TUI 的 ⎿ ├─ └─ 缩进。
 * 递归渲染 TreeItem：每项含 icon + label + status + 可选 children。
 * 缩进通过 depth * 20px padding-left。children 递归渲染。
 */
import type { TreeItem, TreeItemIcon } from '@xyz-agent/extension-protocol'
import {
  ChevronRight, Check, X, Circle, Dot, Pause, GitBranch,
} from '@lucide/vue'
import type { Component } from 'vue'

defineProps<{
  items: TreeItem[]
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

const statusClass = (status?: TreeItem['status']) => {
  if (!status) return ''
  const map = { running: 'text-accent', done: 'text-success', failed: 'text-danger' } as const
  return map[status]
}

const INDENT_PX = 20
const depthPadding = (depth?: number) =>
  depth != null ? { paddingLeft: `${depth * INDENT_PX}px` } : {}
</script>

<template>
  <div class="list-tree font-mono text-[12px] leading-relaxed" data-testid="gui-list-tree">
    <template v-for="(item, i) in items" :key="i">
      <div class="list-tree__item flex items-center gap-1.5" :style="depthPadding(item.depth)">
        <span class="list-tree__icon flex w-3.5 shrink-0 justify-center">
          <component
            v-if="item.icon"
            :is="ICON_MAP[item.icon]"
            class="size-[11px]"
            :class="statusClass(item.status)"
          />
        </span>
        <span class="text-muted">{{ item.label }}</span>
        <span
          v-if="item.status"
          class="list-tree__status text-[10px]"
          :class="statusClass(item.status)"
        >{{ item.status }}</span>
      </div>
      <!-- 递归渲染 children：depth + 1 -->
      <template v-if="item.children && item.children.length > 0">
        <ListTree :items="item.children" />
      </template>
    </template>
  </div>
</template>
