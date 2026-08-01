<script setup lang="ts">
/** BashBlock · BashOutputBlock（v6 spec-blocks §5）
 *  - SquareTerminal icon 14px + cmd（mono）+ exit 标签
 *  - bg-input 容器 rounded-lg 12px 渲染输出，明度差分隔（bb-out 微透白叠层）
 *  - exit 0=success / N=warn，pill（bg-elevated + radius-sm） */
import { computed, ref } from 'vue'

const props = defineProps<{ data: Record<string, unknown> }>()
const cmd = computed(() => (props.data.cmd as string) || '')
const output = computed(() => (props.data.output as string) || '')
const exit = computed(() => props.data.exit as number | undefined)
const hasOutput = computed(() => output.value.length > 0)

const copied = ref(false)
async function copyOutput() {
  try {
    await navigator.clipboard.writeText(output.value)
  } catch { /* clipboard 可能被禁用，忽略 */ }
  copied.value = true
  setTimeout(() => (copied.value = false), 1400)
}
</script>

<template>
  <div class="bob">
    <div class="bb-cmd">
      <!-- SquareTerminal icon -->
      <svg class="bob-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
      <span class="bob-cmd">{{ cmd }}</span>
      <span v-if="exit === 0" class="exit-tag ok">exit 0</span>
      <span v-else-if="typeof exit === 'number' && exit !== 0" class="exit-tag warn">exit {{ exit }}</span>
    </div>
    <div v-if="hasOutput" class="bb-out">
      <div class="out-toolbar">
        <button class="copy-btn" :class="{ copied }" title="复制输出" @click="copyOutput">
          <svg v-if="!copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
      </div>
      <pre>{{ output }}</pre>
    </div>
    <div v-else class="bob-empty">(无输出)</div>
  </div>
</template>

<style scoped>
/* bg-input 容器 rounded-lg 12px（spec-blocks §5）*/
.bob {
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.bb-cmd {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  min-width: 0;
}
.bob-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-ico);
  flex-shrink: 0;
}
.bob-cmd {
  color: var(--neutral-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
/* exit-tag pill：bg-elevated + radius-sm（spec-blocks）*/
.exit-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  margin-left: auto;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.exit-tag.ok { color: var(--success); }
.exit-tag.warn { color: var(--warn); }

/* 输出区：明度差分隔（微透白叠层）+ 7px 12px padding */
.bb-out {
  padding: 7px 12px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--neutral-dim);
}
.out-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 4px;
}
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.copy-btn svg { width: 12px; height: 12px; }
.bb-out:hover .copy-btn { opacity: 1; }
.copy-btn:hover { background: var(--surface-hover); color: var(--neutral-fg); }
.copy-btn.copied { color: var(--success); opacity: 1; }
.bb-out pre {
  max-height: var(--bash-output-max-height);
  overflow-y: auto;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.bob-empty {
  padding: 7px 12px;
  font-style: italic;
  color: var(--neutral-faint);
}
</style>
