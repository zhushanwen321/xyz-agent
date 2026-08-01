<script setup lang="ts">
/**
 * DiffView · git diff 着色渲染
 * dv-canvas：bg-input rounded-lg py-2 凹陷底色
 * 行号（neutral-dim 40px）+ add/del/ctx/hunk 行背景 + 字符级 strong（45%）
 */
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

defineProps<{
  /** 所属文件（用于标题/状态，可选） */
  file?: GitFile
}>()

/** 示例 diff：8 行 hunk，含 add/del/ctx + 字符级 strong */
const lines: DiffLine[] = [
  { type: 'hunk', text: '@@ -10,7 +10,9 @@ export const TOKENS = {' },
  { type: 'ctx', oldNo: 10, newNo: 10, segs: [{ text: '  radius: {' }] },
  { type: 'del', oldNo: 11, segs: [{ text: '    sm: ' }, { text: "'3px'", strong: 'del' }, { text: ',' }] },
  { type: 'add', newNo: 11, segs: [{ text: '    sm: ' }, { text: "'6px'", strong: 'add' }, { text: ',' }] },
  { type: 'ctx', oldNo: 12, newNo: 12, segs: [{ text: "    md: '8px'," }] },
  { type: 'add', newNo: 13, segs: [{ text: "    lg: '12px'," }] },
  { type: 'ctx', oldNo: 13, newNo: 14, segs: [{ text: '  },' }] },
  { type: 'ctx', oldNo: 14, newNo: 15, segs: [{ text: '};' }] },
]

/** 行 class 工具（避免模板内三元过密） */
function rowClass(type: DiffLine['type']): string {
  return type === 'hunk' ? 'dv-hunk-row' : `dv-line ${type}`
}
/** +/- 符号 */
function sign(type: DiffLine['type']): string {
  return type === 'add' ? '+' : type === 'del' ? '-' : ' '
}
</script>

<template>
  <div class="dv-canvas">
    <div v-for="(line, i) in lines" :key="i" :class="rowClass(line.type)">
      <!-- hunk header -->
      <template v-if="line.type === 'hunk'">
        <div class="dv-hunk-header">{{ line.text }}</div>
      </template>
      <!-- code line -->
      <template v-else>
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
      </template>
    </div>
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
