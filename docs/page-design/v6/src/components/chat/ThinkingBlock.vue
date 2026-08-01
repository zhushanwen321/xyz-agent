<script setup lang="ts">
/** ThinkingBlock · 思考块（v6 spec-blocks §4）
 *  - Brain icon 14px + 「Think」label
 *  - collapsed：1 行 ellipsis 预览（neutral-mid）
 *  - expanded：neutral-mid 正文 */
import { ref } from 'vue'

const props = defineProps<{ data: Record<string, unknown> }>()
const expanded = ref(props.data.state === 'expanded' || props.data.expanded === true)
const preview = (props.data.preview as string) || ''
const body = (props.data.body as string) || preview
</script>

<template>
  <div class="tk">
    <div class="tk-row" @click="expanded = !expanded">
      <!-- Brain icon -->
      <svg class="tk-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>
      <span class="tk-label">Think</span>
      <span v-if="!expanded" class="tk-preview">{{ preview }}</span>
    </div>
    <div v-if="expanded" class="tk-body">{{ body }}</div>
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
  letter-spacing: 0.04em;
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
  padding: 6px 0 0 20px;
  font-size: var(--text-sm);
  line-height: 1.7;
  color: var(--neutral-mid);
  white-space: pre-wrap;
}
</style>
