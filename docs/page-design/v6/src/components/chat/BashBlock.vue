<script setup lang="ts">
/** BashBlock · BashOutputBlock（v6 spec-blocks §5，spec-blocks.html:438）
 *  - 容器 py-2 · 无边框无卡片背景（靠 header 语义标识区分，非 bg-input 卡片）
 *  - header：SquareTerminal icon 14px + cmd（mono 12px neutral-fg）+ exit 纯文字标签（无 pill）
 *  - exit 0→success / exit N→warn / timeout·cancelled→dim
 *  - running：双环 loader 12px accent + 取消按钮；excludeFromContext → border pill「不进上下文」
 *  - copy 复制「命令+输出」（行内左对齐，与输出缩进对齐），成功切 Check 1.4s 恢复 */
import { computed, ref } from 'vue'

const props = defineProps<{ data: Record<string, unknown> }>()
const state = computed(() => props.data.state as string | undefined)
const cmd = computed(() => (props.data.cmd as string) || '')
const output = computed(() => (props.data.output as string) || '')
const exit = computed(() => props.data.exit as number | undefined)
const running = computed(() => state.value === 'running')
const truncated = computed(() => props.data.truncated === true)
const noContext = computed(() => props.data.excludeFromContext === true)
const hasOutput = computed(() => output.value.length > 0)

const copied = ref(false)
async function copyBlock() {
  // spec「复制命令+输出」
  const text = cmd.value ? `${cmd.value}\n${output.value}` : output.value
  try {
    await navigator.clipboard.writeText(text)
  } catch { /* clipboard 可能被禁用，忽略 */ }
  copied.value = true
  setTimeout(() => (copied.value = false), 1400)
}
</script>

<template>
  <div class="bob">
    <div class="bob-head">
      <!-- SquareTerminal icon（stroke 1.75 统一）-->
      <svg class="bob-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>
      <span class="bob-cmd">{{ cmd }}</span>
      <!-- no-context tag（excludeFromContext，border pill）-->
      <span v-if="noContext" class="bob-noctx">不进上下文</span>
      <!-- running：双环 loader 12px accent + 取消按钮 -->
      <span v-if="running" class="bob-status running">
        <svg class="bob-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" opacity="0.35"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>
      </span>
      <button v-if="running" class="bob-cancel">取消</button>
      <!-- exit 纯文字标签：exit 0→success / exit N→warn / timeout·cancelled→dim -->
      <span v-else-if="exit === 0" class="bob-status exit0">exit 0</span>
      <span v-else-if="typeof exit === 'number'" class="bob-status exitn">exit {{ exit }}</span>
      <span v-else-if="state === 'timeout'" class="bob-status dim">超时</span>
      <span v-else-if="state === 'cancelled'" class="bob-status dim">已取消</span>
    </div>
    <template v-if="!running">
      <div v-if="hasOutput" class="bob-out-wrap">
        <!-- copy 行内左对齐，padding-left 16px 与输出缩进对齐 -->
        <div class="blk-copy-row">
          <button class="blk-copy" :class="{ copied }" title="复制命令+输出" @click="copyBlock">
            <svg v-if="!copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{{ copied ? 'Copied' : 'Copy' }}</span>
          </button>
        </div>
        <div class="bob-out">{{ output }}</div>
        <div v-if="truncated" class="bob-trunc">⋯ 输出已截断</div>
      </div>
      <div v-else class="bob-empty">(无输出)</div>
    </template>
  </div>
</template>

<style scoped>
/* 无边框无卡片背景：py-2，靠 header 语义标识区分（spec-blocks.html:438）*/
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
  font-size: 12px;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
/* exit 纯文字（无 pill 背景无 padding，base.css .bob-status）*/
.bob-status {
  font-family: var(--font-mono);
  font-size: 10px;
  flex-shrink: 0;
}
.bob-status.running {
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.bob-status.exit0 { color: var(--success); }
.bob-status.exitn { color: var(--warn); }
.bob-status.dim { color: var(--neutral-dim); }
.bob-loader {
  width: 12px;
  height: 12px;
  animation: spin 1.4s linear infinite;
}
.bob-cancel {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--neutral-mid);
  cursor: pointer;
  flex-shrink: 0;
}
.bob-cancel:hover { background: var(--danger-soft); color: var(--danger); }
/* no-context tag：border pill（blocks 独有，spec-blocks.html:53）*/
.bob-noctx {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  color: var(--neutral-dim);
  flex-shrink: 0;
  line-height: 1;
}
/* copy 行内左对齐（与输出基线对齐在行首，padding-left 16px 对齐输出缩进）*/
.blk-copy-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0 0 16px;
}
.blk-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.blk-copy svg { width: 12px; height: 12px; flex-shrink: 0; }
.bob:hover .blk-copy { opacity: 1; }
.blk-copy:hover { background: var(--surface-hover); color: var(--neutral-fg); }
.blk-copy.copied { opacity: 1; color: var(--success); }
/* 输出区：mono 12px neutral-mid · max-h 240px · padding-left 16px 缩进 · line-height 1.5 */
.bob-out-wrap { margin-top: 6px; }
.bob-out {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--neutral-mid);
  max-height: var(--bash-output-max-height, 240px);
  overflow: auto;
  padding-left: 16px;
  white-space: pre-wrap;
  line-height: 1.5;
}
.bob-trunc {
  font-style: italic;
  font-size: 10px;
  color: var(--neutral-dim);
  padding-left: 16px;
  margin-top: 4px;
}
.bob-empty {
  font-size: 11px;
  color: var(--neutral-faint);
  padding-left: 16px;
  margin-top: 4px;
  font-style: italic;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
