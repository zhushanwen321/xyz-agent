<script setup lang="ts">
/** BashBlock · BashOutputBlock（v6 spec-blocks §5）
 *  - SquareTerminal icon 14px + cmd（mono）+ exit 标签
 *  - bg-input 容器 rounded-lg 12px 渲染输出
 *  - exit 0=success / N=warn */
import { computed } from 'vue'

const props = defineProps<{ data: Record<string, unknown> }>()
const cmd = computed(() => (props.data.cmd as string) || '')
const output = computed(() => (props.data.output as string) || '')
const exit = computed(() => props.data.exit as number | undefined)
const hasOutput = computed(() => output.value.length > 0)
</script>

<template>
  <div class="bob">
    <div class="bob-head">
      <!-- SquareTerminal icon -->
      <svg class="bob-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
      <span class="bob-cmd">{{ cmd }}</span>
      <span v-if="exit === 0" class="exit-tag ok">exit 0</span>
      <span v-else-if="typeof exit === 'number' && exit !== 0" class="exit-tag warn">exit {{ exit }}</span>
    </div>
    <div v-if="hasOutput" class="bob-box">
      <pre class="bob-out">{{ output }}</pre>
    </div>
    <div v-else class="bob-empty">(无输出)</div>
  </div>
</template>

<style scoped>
.bob { padding: 8px 0; }
.bob-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.bob-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-ico);
  flex-shrink: 0;
}
.bob-cmd {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.exit-tag {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.exit-tag.ok { color: var(--success); }
.exit-tag.warn { color: var(--warn); }
.bob-box {
  margin-top: 6px;
  max-height: var(--bash-output-max-height);
  overflow-y: auto;
}
.bob-out {
  margin-top: 6px;
  padding-left: 16px;
  background: transparent;
  border-radius: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--neutral-mid);
  white-space: pre-wrap;
  word-break: break-word;
}
.bob-empty {
  margin-top: 6px;
  padding-left: 20px;
  font-size: var(--text-sm);
  font-style: italic;
  color: var(--neutral-dim);
}
</style>
