<script setup lang="ts">
/**
 * 列表树组件——替代 TUI 的 ⎿ ├─ └─ 缩进。
 * 递归渲染 TreeItem：每项含 icon + label + status + 可选 children。
 * 缩进通过 depth * 20px padding-left。children 递归渲染时自动 depth+1。
 */
import { useI18n } from 'vue-i18n'
import type { TreeItem, TreeItemIcon } from '@xyz-agent/extension-protocol'
import {
  ChevronRight, Check, X, Circle, Dot, Pause, GitBranch,
} from '@lucide/vue'
import type { Component } from 'vue'

const { t } = useI18n()

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

const statusClass = (status?: TreeItem['status']) => {
  if (!status) return ''
  const map = { running: 'text-accent', done: 'text-success', failed: 'text-danger' } as const
  return map[status]
}

/** status 枚举 → 中文标签（避免直接展示英文 running/done/failed） */
const STATUS_LABEL: Record<NonNullable<TreeItem['status']>, string> = {
  running: t('panel.listTree.running'),
  done: t('panel.listTree.done'),
  failed: t('panel.listTree.failed'),
}

const INDENT_PX = 20
const currentDepth = () => props.depth ?? 0
const depthPadding = () => ({ paddingLeft: `${currentDepth() * INDENT_PX}px` })
</script>

<template>
  <div class="list-tree font-mono text-[12px] leading-relaxed" data-testid="gui-list-tree">
    <template v-for="(item, i) in items" :key="i">
      <div class="list-tree__item flex items-center gap-1.5" :style="depthPadding()">
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
        >{{ STATUS_LABEL[item.status] }}</span>
      </div>
      <!-- 递归渲染 children：depth + 1 自动缩进 -->
      <template v-if="item.children && item.children.length > 0">
        <ListTree :items="item.children" :depth="currentDepth() + 1" />
      </template>
    </template>
  </div>
</template>
