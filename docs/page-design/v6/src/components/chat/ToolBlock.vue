<script setup lang="ts">
/** ToolBlock · 工具调用块（v6 spec-blocks §6）
 *  - SquareFunction icon 14px + name + arg + exit 标签
 *  - collapsed：单行（icon + name + argPath）
 *  - expanded：copy + meta 条(lines/chars/elapsed) + output
 *  - running：双环 loader，name 染 accent */
import { computed, ref } from 'vue'

const props = defineProps<{ data: Record<string, unknown> }>()
const name = computed(() => (props.data.name as string) || 'tool')
const arg = computed(() => (props.data.arg as string) || '')
const cmd = computed(() => (props.data.cmd as string) || '')
const exit = computed(() => props.data.exit as number | undefined)
const output = computed(() => (props.data.output as string) || '')
const meta = computed(() => props.data.meta as { lines?: number; chars?: string; elapsed?: string } | undefined)
const state = computed(() => props.data.state as string | undefined)
const running = computed(() => state.value === 'running')
const failed = computed(() => state.value === 'failed')
const unfinished = computed(() => state.value === 'unfinished')
/** tool-bash 分支（spec-blocks §5B）：agent 调用的 bash，嵌 tool 块可折叠 */
const isBash = computed(() => props.data.toolType === 'bash' || name.value === 'Bash')

const expanded = ref(state.value === 'expanded')

const copied = ref(false)
async function copyTool() {
  // spec「复制全部：bash=命令+输出，其余=输出」
  const text = isBash.value && cmd.value ? `${cmd.value}\n${output.value}` : output.value
  try {
    await navigator.clipboard.writeText(text)
  } catch { /* clipboard 可能被禁用，忽略 */ }
  copied.value = true
  setTimeout(() => (copied.value = false), 1400)
}
</script>

<template>
  <div class="tool">
    <div class="tool-hd" @click="!running && (expanded = !expanded)">
      <!-- running：双环 loader（accent），其余 SquareFunction -->
      <svg v-if="running" class="tool-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" opacity="0.35"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>
      <svg v-else class="tool-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3"/><path d="M9 11.2h5.7"/></svg>
      <span class="tool-name" :class="{ running, failed, unfinished }">{{ name }}</span>
      <span v-if="arg" class="tool-arg">· {{ arg }}</span>
      <span v-if="typeof exit === 'number' && exit !== 0" class="exit-tag">{{ exit === 0 ? '' : 'exit ' + exit }}</span>
      <span v-else-if="state === 'unfinished'" class="exit-tag">未结束</span>
    </div>
    <div v-if="expanded && !running" class="tool-body">
      <!-- 非 bash：copy + meta 条 + output -->
      <template v-if="!isBash">
        <div class="meta-row">
          <button class="copy-btn" :class="{ copied }" title="复制输出" @click="copyTool">
            <svg v-if="!copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{{ copied ? 'Copied' : 'Copy' }}</span>
          </button>
          <span v-if="meta" class="meta-pills">
            <span v-if="meta.lines">{{ meta.lines }} 行</span>
            <span v-if="meta.chars">{{ meta.chars }} chars</span>
            <span v-if="meta.elapsed">{{ meta.elapsed }}</span>
          </span>
        </div>
        <pre v-if="output" class="tool-out">{{ output }}</pre>
      </template>
      <!-- tool-bash（§5B）：bg-input 无 border rounded-sm 容器 + 命令行 + 输出 -->
      <template v-else>
        <div class="meta-row">
          <button class="copy-btn" :class="{ copied }" title="复制命令+输出" @click="copyTool">
            <svg v-if="!copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{{ copied ? 'Copied' : 'Copy' }}</span>
          </button>
        </div>
        <div class="tool-bash-box">
          <div class="tool-bash-cmd">{{ cmd }}</div>
          <div class="tool-bash-out">{{ output }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tool { padding: 8px 0; }
.tool-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: pointer;
}
.tool-ico, .tool-loader {
  width: 13px;
  height: 13px;
  color: var(--neutral-ico);
  flex-shrink: 0;
}
.tool-loader { color: var(--accent); animation: spin 1.4s linear infinite; }
.tool-name {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--neutral-fg);
}
.tool-name.running { color: var(--accent); }
.tool-name.failed { color: var(--neutral-mid); }
.tool-name.unfinished { color: var(--neutral-mid); }
.tool-arg {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--neutral-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.exit-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  margin-left: auto;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  flex-shrink: 0;
}
.tool-body {
  padding: 6px 0 0 16px;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
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
.tool-body:hover .copy-btn { opacity: 1; }
.copy-btn:hover { background: var(--surface-hover); color: var(--neutral-fg); }
.copy-btn.copied { opacity: 1; color: var(--success); }
.meta-pills {
  display: inline-flex;
  gap: 12px;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.tool-out {
  max-height: var(--bash-output-max-height);
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--neutral-mid);
  white-space: pre-wrap;
  word-break: break-word;
}
/* tool-bash 容器（§5B）：bg-input 无 border rounded-sm，命令行/输出分隔 */
.tool-bash-box {
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  overflow: hidden;
}
.tool-bash-cmd {
  padding: 6px 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--neutral-fg);
  border-bottom: 1px solid var(--border);
}
.tool-bash-out {
  padding: 6px 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--neutral-mid);
  line-height: 1.5;
  white-space: pre-wrap;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
