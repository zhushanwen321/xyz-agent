<script setup lang="ts">
import UiInput from './UiInput.vue'
import type { ProviderHeader, ProviderQuotaWindow } from '@/mock/sessions'

/** ProviderAdvancedSection：展开区「高级」子区（默认折叠）。
 * M10 自定义 Headers 行编辑（key+value 双 input，添加/删除行）+ M9 Coding Plan 三窗口额度（mock 驱动 + 刷新）。*/
defineProps<{
  headers: ProviderHeader[]
  quota: ProviderQuotaWindow[]
  busy: boolean
  error: string
  quotaOk: boolean
}>()
const emit = defineEmits<{
  (e: 'add-header'): void
  (e: 'remove-header', index: number): void
  (e: 'header-change', index: number, field: 'key' | 'value', value: string): void
  (e: 'refresh-quota'): void
}>()
</script>

<template>
  <div class="adv-body">
    <div class="cred-field cred-field-wide">
      <label class="field-label">自定义 Headers <span class="fld-hint">附加请求头</span></label>
      <div class="header-rows">
        <div v-for="(h, i) in headers" :key="i" class="header-row">
          <UiInput
            :model-value="h.key"
            placeholder="X-Custom-Header"
            :mono="true"
            class="header-row-input"
            aria-label="header 名"
            @update:model-value="emit('header-change', i, 'key', $event)"
          />
          <UiInput
            :model-value="h.value"
            placeholder="value"
            :mono="true"
            class="header-row-input"
            aria-label="header 值"
            @update:model-value="emit('header-change', i, 'value', $event)"
          />
          <button class="btn btn-danger btn-icon-sm header-del" type="button" aria-label="移除 header" @click="emit('remove-header', i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
      <button class="add-kv-link" type="button" @click="emit('add-header')">+ 添加 header</button>
      <div class="eg-hair"></div>

      <label class="field-label">Coding Plan 额度 <span class="fld-hint">查询 5h 滚动 / 本周 / 本月三窗口配额</span></label>
      <div class="quota-wins">
        <div v-for="w in quota" :key="w.label" class="quota-win" :class="w.level ?? ''">
          <div class="qw-label">{{ w.label }}</div>
          <div class="qw-track"><div class="qw-fill" :class="w.level ?? 'normal'" :style="{ width: w.pct + '%' }"></div></div>
          <div class="qw-pct">{{ w.pct }}%</div>
          <div class="qw-reset">{{ w.reset }}</div>
        </div>
      </div>
      <div class="quota-ops">
        <button class="btn btn-secondary btn-dense" type="button" :disabled="busy" @click="emit('refresh-quota')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          刷新额度
        </button>
        <span v-if="busy" class="test-result loading">查询中…</span>
        <span v-else-if="error" class="test-result fail">{{ error }}</span>
        <span v-else-if="quotaOk" class="test-result ok">查询成功 · 三窗口配额已更新</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.header-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.header-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.header-row-input {
  flex: 1;
  min-width: 0;
}
.header-del {
  flex-shrink: 0;
}
.header-del svg {
  width: 14px;
  height: 14px;
}
.add-kv-link {
  align-self: flex-start;
  font-size: var(--text-sm);
  color: var(--accent);
  cursor: pointer;
  padding: 4px 0;
}
.eg-hair {
  height: 1px;
  background: var(--border);
  margin: var(--space-3) 0;
}
.quota-wins {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
}
.quota-win {
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
}
.qw-label {
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  font-family: var(--font-mono);
}
.qw-track {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-input);
  margin-top: 6px;
  overflow: hidden;
}
.qw-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width var(--duration) var(--ease);
}
.qw-fill.high {
  background: var(--warn);
}
.qw-fill.full {
  background: var(--danger);
}
.qw-pct {
  margin-top: 4px;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
  font-family: var(--font-mono);
}
.qw-reset {
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  margin-top: 2px;
}
.quota-win.high .qw-pct {
  color: var(--warn);
}
.quota-win.full .qw-pct {
  color: var(--danger);
}
.quota-ops {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
}
.quota-ops .btn svg {
  width: 14px;
  height: 14px;
}
.test-result {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
}
.test-result.ok {
  color: var(--success);
}
.test-result.fail {
  color: var(--danger);
}
.test-result.loading {
  color: var(--neutral-mid);
}
</style>
