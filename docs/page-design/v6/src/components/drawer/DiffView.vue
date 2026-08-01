<script setup lang="ts">
/**
 * DiffView · git diff 着色渲染
 * dv-canvas：bg-input rounded-lg py-2 凹陷底色
 * 行号（neutral-dim 40px）+ add/del/ctx/hunk 行背景 + 字符级 strong（45%）
 */
import { computed } from 'vue'
import type { GitFile } from '@/mock/sessions'

interface DiffSeg {
  /** 强调片段文本（字符级 strong） */
  text: string
  /** 强调方向 */
  strong?: 'add' | 'del'
}

export interface DiffLine {
  /** old 文件行号（删除行有，新增行为空） */
  oldNo?: number
  /** new 文件行号（新增行有，删除行为空） */
  newNo?: number
  type: 'add' | 'del' | 'ctx' | 'hunk'
  /** 行内容片段（ctx/add/del） */
  segs?: DiffSeg[]
  /** hunk header 文本（type=hunk） */
  text?: string
}

const props = defineProps<{
  /** 所属文件：按文件渲染对应 diff（多文件 tab 各自独立，spec §3「每个 tab 显示该文件内容」） */
  file?: GitFile
}>()

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

/** 默认组（design 文档）：spec §4 目标态 hunk + 6 行 code（radius tokens） */
const DEFAULT_LINES: DiffLine[] = [
  { type: 'hunk', text: '@@ -10,7 +10,9 @@ export const TOKENS = {' },
  { type: 'ctx', oldNo: 10, newNo: 10, segs: [{ text: '  radius: {' }] },
  { type: 'del', oldNo: 11, segs: [{ text: '    sm: ' }, { text: "'3px'", strong: 'del' }, { text: ',' }] },
  { type: 'add', newNo: 11, segs: [{ text: '    sm: ' }, { text: "'6px'", strong: 'add' }, { text: ',' }] },
  { type: 'ctx', oldNo: 12, newNo: 12, segs: [{ text: "    md: '8px'," }] },
  { type: 'add', newNo: 13, segs: [{ text: "    lg: '12px'," }] },
  { type: 'ctx', oldNo: 13, newNo: 14, segs: [{ text: '  },' }] },
]

/** demo diff 数据：mock 的 GitFile 无 lines 字段，按文件名分支给 2-3 组不同行数据 */
const DIFF_BY_FILE: Record<string, DiffLine[]> = {
  'v6-design.md': DEFAULT_LINES,
  'v6-spec-shell.html': [
    { type: 'hunk', text: '@@ -40,7 +40,7 @@ .window-frame {' },
    { type: 'ctx', oldNo: 40, newNo: 40, segs: [{ text: '.window-frame {' }] },
    { type: 'del', oldNo: 41, segs: [{ text: '  gap: ' }, { text: '16px', strong: 'del' }, { text: ';' }] },
    { type: 'add', newNo: 41, segs: [{ text: '  gap: ' }, { text: '12px', strong: 'add' }, { text: ';' }] },
    { type: 'ctx', oldNo: 42, newNo: 42, segs: [{ text: '  border-radius: 10px;' }] },
    { type: 'ctx', oldNo: 43, newNo: 43, segs: [{ text: '  padding: 12px;' }] },
    { type: 'del', oldNo: 44, segs: [{ text: '  box-shadow: none;' }] },
    { type: 'add', newNo: 44, segs: [{ text: '  box-shadow: var(--shadow-1);' }] },
  ],
  'v6-spec-drawer.html': [
    { type: 'hunk', text: '@@ -195,7 +195,7 @@ .sd-drawer {' },
    { type: 'ctx', oldNo: 195, newNo: 195, segs: [{ text: '.sd-drawer {' }] },
    { type: 'del', oldNo: 196, segs: [{ text: '  border-left: 1px solid var(--border);' }] },
    { type: 'add', newNo: 196, segs: [{ text: '  box-shadow: var(--shadow-drawer);' }] },
    { type: 'ctx', oldNo: 197, newNo: 197, segs: [{ text: '  display: flex;' }] },
    { type: 'ctx', oldNo: 198, newNo: 198, segs: [{ text: '  flex-direction: column;' }] },
    { type: 'ctx', oldNo: 199, newNo: 199, segs: [{ text: '  overflow: hidden;' }] },
    { type: 'ctx', oldNo: 200, newNo: 200, segs: [{ text: '}' }] },
  ],
}

/** 当前文件对应 diff（未匹配回退默认组） */
const lines = computed<DiffLine[]>(() => {
  if (!props.file) return DEFAULT_LINES
  return DIFF_BY_FILE[basename(props.file.name)] ?? DEFAULT_LINES
})

/** 行 class 工具（仅 code 行；hunk 直接渲染为 .dv-hunk-header，无外层行包装） */
function rowClass(type: DiffLine['type']): string {
  return `dv-line ${type}`
}
/** +/- 符号 */
function sign(type: DiffLine['type']): string {
  return type === 'add' ? '+' : type === 'del' ? '-' : ' '
}
</script>

<template>
  <div class="dv-canvas">
    <template v-for="(line, i) in lines" :key="i">
      <!-- hunk header：直接作为 canvas 子级渲染（无 dv-hunk-row 外层包装） -->
      <div v-if="line.type === 'hunk'" class="dv-hunk-header">{{ line.text }}</div>
      <!-- code line -->
      <div v-else :class="rowClass(line.type)">
        <span class="dv-oldno">{{ line.oldNo ?? '' }}</span>
        <span class="dv-newno">{{ line.newNo ?? '' }}</span>
        <span class="dv-sign">{{ sign(line.type) }}</span>
        <span class="dv-code">
          <template v-for="(seg, j) in line.segs" :key="j">
            <span v-if="seg.strong === 'add'" class="dv-seg-add">{{ seg.text }}</span>
            <span v-else-if="seg.strong === 'del'" class="dv-seg-del">{{ seg.text }}</span>
            <span v-else>{{ seg.text }}</span>
          </template>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dv-canvas {
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  padding: 8px 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.5;
  overflow: hidden;
}

.dv-hunk-header {
  padding: 3px 12px;
  color: var(--neutral-dim);
  background: transparent;
}

.dv-line {
  display: flex;
  align-items: baseline;
  padding: 0;
}

.dv-line .dv-oldno,
.dv-line .dv-newno {
  width: 40px;
  flex-shrink: 0;
  padding: 0 6px;
  text-align: right;
  color: var(--neutral-dim);
  user-select: none;
}
.dv-line .dv-newno {
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease);
}
.dv-line .dv-newno:hover {
  color: var(--accent);
}

.dv-line .dv-sign {
  width: 16px;
  flex-shrink: 0;
  text-align: center;
  user-select: none;
}

.dv-line .dv-code {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* add 行：行背景 + 字色 */
.dv-line.add {
  background: var(--diff-add-bg);
}
.dv-line.add .dv-sign,
.dv-line.add .dv-code {
  color: var(--success);
}

/* del 行：行背景 + 字色 */
.dv-line.del {
  background: var(--diff-del-bg);
}
.dv-line.del .dv-sign,
.dv-line.del .dv-code {
  color: var(--danger);
}
/* del 行 newNo 占位透明（不可点） */
.dv-line.del .dv-newno {
  color: transparent;
  cursor: default;
}

/* ctx 行：弱化 */
.dv-line.ctx .dv-sign {
  color: var(--neutral-faint);
}
.dv-line.ctx .dv-code {
  color: var(--neutral-fg);
  opacity: 0.85;
}

/* 字符级 strong（45%，叠加行背景） */
.dv-seg-add {
  background: var(--diff-add-strong);
}
.dv-seg-del {
  background: var(--diff-del-strong);
}
</style>
