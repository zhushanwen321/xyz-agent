<script setup lang="ts">
/** ThinkingBlock · 思考块（v6 spec-blocks §4）
 *  - Brain icon 14px + 「Think」label
 *  - collapsed：1 行 ellipsis 预览（neutral-mid）
 *  - expanded：copy 按钮 + neutral-mid 正文 */
import { ref } from 'vue'

const props = defineProps<{ data: Record<string, unknown> }>()
const expanded = ref(props.data.state === 'expanded' || props.data.expanded === true)
const preview = (props.data.preview as string) || ''
const body = (props.data.body as string) || preview

const copied = ref(false)
async function copyBody() {
  try {
    await navigator.clipboard.writeText(body)
  } catch { /* clipboard 可能被禁用，忽略 */ }
  copied.value = true
  setTimeout(() => (copied.value = false), 1400)
}
</script>

<template>
  <div class="tk">
    <div class="tk-row" @click="expanded = !expanded">
      <!-- Brain icon -->
      <svg class="tk-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>
      <span class="tk-label">Think</span>
      <span v-if="!expanded" class="tk-preview">{{ preview }}</span>
    </div>
    <div v-if="expanded" class="tk-body">
      <div class="body-toolbar">
        <button class="copy-btn" :class="{ copied }" title="复制思考正文" @click="copyBody">
          <svg v-if="!copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          <span>{{ copied ? 'Copied' : 'Copy' }}</span>
        </button>
      </div>
      <div class="body-text">{{ body }}</div>
    </div>
  </div>
</template>

<style scoped>
.tk { padding: 8px 0; }
.tk-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: pointer;
}
.tk-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-ico);
  flex-shrink: 0;
}
.tk-label {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--neutral-fg);
  margin-right: 2px;
  flex-shrink: 0;
}
.tk-preview {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.tk-body {
  padding: 6px 0 0 16px;
}
.body-toolbar {
  display: flex;
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
.tk-body:hover .copy-btn { opacity: 1; }
.copy-btn:hover { background: var(--surface-hover); color: var(--neutral-fg); }
.copy-btn.copied { color: var(--success); opacity: 1; }
.body-text {
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--neutral-mid);
  white-space: pre-wrap;
}
</style>
