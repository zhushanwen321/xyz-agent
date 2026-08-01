<script setup lang="ts">
/** FileTreeView：文件树。
 *  v6 核心改动（spec §6）：缩进 INDENT_STEP 10px · icon-文字 gap 4px；
 *  git badge 缩小保留语义色（M/A/D/U/R）；目录改动数降中性；ignored 灰斜体。
 *  选中态 bg-surface（§3.2 列表项型）。 */

import { ref } from 'vue'
import {
  fileTree,
  type FileNode,
  type SessionItem,
} from '@/mock/sessions'
import { activeSessionId } from '@/composables/useStore'
import { sessions } from '@/mock/sessions'

const BASE_PADDING = 8 // depth=0 起始
const INDENT_STEP = 10 // v6：14→10（spec §1.3#12）

/** 当前选中 session（用于 header 显示） */
const activeSession = sessions.find(
  (s) => s.id === activeSessionId.value,
) as SessionItem | undefined

const showIgnored = ref(false)

/** 选中的文件路径（mock 选中态演示，取第一个被追踪文件名） */
const selectedName = ref<string | null>(null)

function padLeft(depth: number) {
  return `${BASE_PADDING + depth * INDENT_STEP}px`
}

function onSelect(node: FileNode) {
  selectedName.value = node.name
}

function iconClass(node: FileNode): string {
  if (node.ignored) return 'is-dim'
  if (node.type === 'dir') return 'is-dir'
  switch (node.gitStatus) {
    case 'A':
      return 'is-success'
    case 'D':
      return 'is-dim'
    case 'U':
      return 'is-warn'
    case 'M':
      return 'is-info'
    default:
      return 'is-mid'
  }
}

/** 目录 lucide path（path 元素 d 属性） */
const FOLDER_PATH =
  'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'
/** 文件 lucide：path + polyline（FileText 图标） */
const FILE_PATH_D =
  'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'
const FILE_POLYLINE = '14 2 14 8 20 8'

function visibleNodes(): FileNode[] {
  return showIgnored.value ? fileTree : fileTree.filter((n) => !n.ignored)
}
</script>

<template>
  <div class="fv">
    <!-- header：session + branch + showIgnored toggle -->
    <div class="fv__head">
      <div class="fv__session">
        <span class="fv__session-name">{{ activeSession?.title || 'session' }}</span>
        <span class="fv__session-branch"> · {{ activeSession?.branch || 'main' }}</span>
      </div>
      <button
        class="fv__toggle"
        type="button"
        :class="{ 'fv__toggle--on': showIgnored }"
        @click="showIgnored = !showIgnored"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>忽略项</span>
      </button>
    </div>

    <!-- 文件树 -->
    <div class="fv__tree">
      <div
        v-for="(node, i) in visibleNodes()"
        :key="i"
        class="tr-row"
        :class="{ 'tr-row--sel': selectedName === node.name }"
        :style="{ paddingLeft: padLeft(node.depth) }"
        @click="onSelect(node)"
      >
        <!-- chevron 槽（14px 固定宽，目录/文件对齐） -->
        <span class="tr-row__chev-slot">
          <svg
            v-if="node.type === 'dir'"
            class="tr-row__chev"
            :class="{ 'tr-row__chev--open': node.expanded }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>

        <!-- 文件夹/文件 icon（14px） -->
        <svg
          class="tr-row__ico"
          :class="iconClass(node)"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path v-if="node.type === 'dir'" :d="FOLDER_PATH" />
          <template v-else>
            <path :d="FILE_PATH_D" />
            <polyline :points="FILE_POLYLINE" />
          </template>
        </svg>

        <span
          class="tr-row__name"
          :class="{ 'tr-row__name--ignored': node.ignored }"
        >
          {{ node.name }}
        </span>

        <!-- 目录改动数徽章（中性） -->
        <span
          v-if="node.type === 'dir' && node.childCount"
          class="tr-row__dirbadge"
        >
          {{ node.childCount }}
        </span>

        <!-- git badge -->
        <span
          v-if="node.gitStatus"
          class="tr-row__git"
          :class="`tr-row__git--${node.gitStatus}`"
        >
          {{ node.gitStatus }}
        </span>

        <!-- 行数 stats -->
        <span v-if="node.stats" class="tr-row__stats">
          <span v-if="node.stats.add" class="tr-row__stats-add">
            +{{ node.stats.add }}
          </span>
          <span v-if="node.stats.del" class="tr-row__stats-del">
            −{{ node.stats.del }}
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fv {
  padding: 0 4px;
}
.fv__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
}
.fv__session {
  min-width: 0;
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fv__session-name {
  color: var(--neutral-fg);
}
.fv__session-branch {
  color: var(--neutral-mid); /* v6：branch 降 neutral-mid（去 accent） */
}
.fv__toggle {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 0;
  font-family: inherit;
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.fv__toggle:hover {
  background: var(--surface-hover);
}
.fv__toggle--on {
  color: var(--accent);
}
.fv__toggle svg {
  width: 12px;
  height: 12px;
}

/* 文件树行 */
.fv__tree {
  display: flex;
  flex-direction: column;
  min-width: max-content;
}
.tr-row {
  display: flex;
  align-items: center;
  gap: 4px; /* v6：6→4 */
  padding: 2px 8px 2px 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease);
}
.tr-row:hover {
  background: var(--surface-hover);
}
.tr-row--sel {
  background: var(--surface); /* §3.2 列表项型选中 */
}
.tr-row__chev-slot {
  width: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tr-row__chev {
  width: 12px;
  height: 12px;
  color: var(--neutral-dim);
  transition: transform var(--duration-fast) var(--ease);
}
.tr-row__chev--open {
  transform: rotate(90deg);
}
.tr-row__ico {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.tr-row__ico.is-dir {
  color: var(--neutral-mid);
}
.tr-row__ico.is-info {
  color: var(--info);
}
.tr-row__ico.is-success {
  color: var(--success);
}
.tr-row__ico.is-warn {
  color: var(--warn);
}
.tr-row__ico.is-mid {
  color: var(--neutral-mid);
}
.tr-row__ico.is-dim {
  color: var(--neutral-dim);
}
.tr-row__name {
  flex-shrink: 0;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--neutral-fg);
}
.tr-row__name--ignored {
  color: var(--neutral-dim);
  font-style: italic;
}
.tr-row--sel .tr-row__name {
  font-weight: 600;
  color: var(--accent);
}

/* 目录改动数徽章：降中性（去 accent） */
.tr-row__dirbadge {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--neutral-mid);
}

/* git badge：mono 10px，语义色 */
.tr-row__git {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  line-height: 1.5;
}
.tr-row__git--M {
  background: var(--warn-soft);
  color: var(--warn);
}
.tr-row__git--A {
  background: var(--success-soft);
  color: var(--success);
}
.tr-row__git--D {
  background: var(--danger-soft);
  color: var(--danger);
}
.tr-row__git--U {
  background: var(--danger-soft);
  color: var(--danger);
  font-weight: 700;
}
.tr-row__git--R {
  background: var(--info-soft);
  color: var(--info);
}

/* 行数 stats */
.tr-row__stats {
  flex-shrink: 0;
  display: inline-flex;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
}
.tr-row__stats-add {
  color: var(--success);
}
.tr-row__stats-del {
  color: var(--danger);
}
</style>
