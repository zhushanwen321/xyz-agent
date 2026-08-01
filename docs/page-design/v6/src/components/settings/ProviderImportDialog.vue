<script setup lang="ts">
import { computed, ref } from 'vue'
import { importPreviews, type ImportPreviewItem, type ImportSource } from '@/mock/sessions'

/** M12 导入流程（spec §4）：状态机 idle → previewing → applying → done。
 * 步骤：源选择（4 Agent / 粘贴 JSON）→ 校验 → 预览（冲突禁用 + key 警告）→ 导入选中 → 成功/失败反馈。
 * 失败时对话框保持开（内联错误允许重试）。*/
const emit = defineEmits<{ (e: 'close'): void; (e: 'imported', count: number): void }>()

type Step = 'source' | 'preview'
const step = ref<Step>('source')
const source = ref<ImportSource | null>(null)
const busy = ref(false)
const preview = ref<ImportPreviewItem[]>([])
const topWarnings = ref<string[]>([])
const parseError = ref('')
const selected = ref<Record<string, boolean>>({})
const warnOpen = ref<Record<string, boolean>>({})
const error = ref('')
const success = ref<{ count: number; keyMissing: boolean } | null>(null)
const jsonText = ref('')
const isJsonMode = ref(false)

const SOURCES: { key: ImportSource; label: string; icon: string }[] = [
  { key: 'pi', label: 'Pi', icon: '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>' },
  { key: 'zcode', label: 'ZCode', icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>' },
  { key: 'codex', label: 'Codex', icon: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  { key: 'claude', label: 'Claude Code', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
]

const sourceTitle = computed(() => SOURCES.find((s) => s.key === source.value)?.label ?? '')
const importableCount = computed(() => preview.value.filter((i) => selected.value[i.id]).length)
const conflictCount = computed(() => preview.value.filter((i) => i.conflict).length)
const keyMissingCount = computed(() => preview.value.filter((i) => selected.value[i.id] && !i.apiKeyExtracted).length)

function pickSource(s: ImportSource) {
  if (busy.value) return
  source.value = s
  busy.value = true
  error.value = ''
  success.value = null
  const found = importPreviews.find((x) => x.source === s)
  setTimeout(() => {
    busy.value = false
    step.value = 'preview'
    preview.value = found ? JSON.parse(JSON.stringify(found.items)) : []
    topWarnings.value = found?.topWarnings ?? []
    parseError.value = found?.parseError ?? ''
    selected.value = {}
    preview.value.forEach((i) => (selected.value[i.id] = !i.conflict))
  }, 450)
}

/** 粘贴 JSON 校验：数组或 {providers: []}，name 必填，proto/modelCount 兜底 */
function parseJson() {
  error.value = ''
  success.value = null
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText.value)
  } catch (e) {
    error.value = 'JSON 解析失败：' + (e as Error).message + ' · 修正后重试'
    return
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { providers?: unknown[] } | null)?.providers
  if (!Array.isArray(arr)) {
    error.value = 'JSON 结构无效：需为数组或 {"providers": [...]}'
    return
  }
  isJsonMode.value = true
  source.value = null
  step.value = 'preview'
  preview.value = arr.map((x, i) => {
    const item = (x ?? {}) as Record<string, unknown>
    return {
      id: 'j-' + i,
      name: String(item.name ?? 'unnamed-' + i),
      proto: String(item.proto ?? 'openai-completions'),
      modelCount: Number(item.modelCount ?? 0),
      apiKeyExtracted: Boolean(item.apiKey),
      conflict: false,
    }
  })
  topWarnings.value = []
  parseError.value = ''
  selected.value = {}
  preview.value.forEach((i) => (selected.value[i.id] = true))
}

function applyImport() {
  const ids = preview.value.filter((i) => selected.value[i.id]).map((i) => i.id)
  if (ids.length === 0) {
    error.value = '请至少勾选一个 provider'
    return
  }
  busy.value = true
  error.value = ''
  success.value = null
  setTimeout(() => {
    busy.value = false
    // mock 失败路径：claude 源固定失败（spec §4 边缘情况示例），对话框保持开
    if (source.value === 'claude') {
      error.value = '导入失败：文件读取权限被拒 · 关闭后重试'
      return
    }
    const keyMissing = preview.value.some((i) => ids.includes(i.id) && !i.apiKeyExtracted)
    success.value = { count: ids.length, keyMissing }
    setTimeout(() => {
      emit('imported', ids.length)
      emit('close')
    }, 900)
  }, 600)
}

function backToSource() {
  if (busy.value) return
  step.value = 'source'
  error.value = ''
  success.value = null
  preview.value = []
}
</script>

<template>
  <div class="import-mask" @click.self="!busy && emit('close')">
    <div class="import-dialog" role="dialog" aria-modal="true" aria-label="导入 Provider">
      <div class="import-hd">
        <div>
          <div class="import-title">导入 Provider</div>
          <div class="import-desc">{{ step === 'source' ? '从其他 Agent 导入，或粘贴 JSON 配置' : '勾选要导入的 provider，冲突项会跳过' }}</div>
        </div>
        <button class="import-x" title="关闭" :disabled="busy" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- 步骤 1：多源选择 / 粘贴 JSON -->
      <div v-if="step === 'source'">
        <div class="import-sources">          <button v-for="s in SOURCES" :key="s.key" class="import-source" :disabled="busy" @click="pickSource(s.key)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" v-html="s.icon"></svg>
            {{ s.label }}
            <svg v-if="busy && source === s.key" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
          </button>
        </div>
        <div class="json-box">
          <div class="json-label">或粘贴 JSON 配置（校验后预览）</div>
          <textarea v-model="jsonText" class="json-area" rows="3" spellcheck="false" placeholder='[{"name":"openai-main","proto":"openai-completions","modelCount":5}]'></textarea>
          <button class="btn btn-secondary btn-md" :disabled="busy" @click="parseJson">解析并预览</button>
        </div>
      </div>

      <div v-if="error" class="inline-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>{{ error }}</span>
      </div>

      <!-- 步骤 2：预览 + 冲突处理 -->
      <div v-else>
        <div v-if="topWarnings.length" class="warn-banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>{{ topWarnings[0] }}</span>
        </div>
        <div v-if="parseError" class="warn-banner">{{ parseError }}</div>
        <div v-if="preview.length === 0" class="preview-empty">暂无模型</div>
        <div class="preview-list">
          <div v-for="item in preview" :key="item.id" class="preview-item" :class="{ conflict: item.conflict }">
            <div class="pi-top">
              <button
                class="ui-checkbox"
                :class="{ checked: selected[item.id], disabled: item.conflict }"
                role="checkbox"
                :aria-checked="!!selected[item.id]"
                :aria-disabled="item.conflict"
                :aria-label="item.name"
                :disabled="item.conflict"
                @click="selected[item.id] = !selected[item.id]"
              >
                <svg v-if="selected[item.id]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
              <span class="pi-id">{{ item.name }}</span>
              <span class="pi-proto">{{ item.proto }}</span>
              <span class="pi-count">{{ item.modelCount }} 模型</span>
              <span v-if="!item.apiKeyExtracted" class="pi-keywarn" title="API Key 未提取">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 3l-3-3"/></svg>
              </span>
              <span v-if="item.conflict" class="pi-conflict-badge">已存在同名</span>
            </div>
            <button v-if="item.warnings?.length" class="pi-warn-toggle" @click="warnOpen[item.id] = !warnOpen[item.id]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :style="warnOpen[item.id] ? 'transform:rotate(90deg)' : ''"><polyline points="9 18 15 12 9 6"/></svg>
              警告 ({{ item.warnings.length }})
            </button>
            <ul v-if="warnOpen[item.id]" class="pi-warn-list">
              <li v-for="w in item.warnings" :key="w">{{ w }}</li>
            </ul>
          </div>
        </div>
        <div class="preview-stats">
          <span>{{ importableCount }} 个可导入</span>
          <span>{{ conflictCount }} 个冲突</span>
          <span>{{ keyMissingCount }} 个 key 未提取</span>
        </div>
        <div v-if="success" class="import-success">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          导入 {{ success.count }} 个 provider{{ success.keyMissing ? ' · 部分需手动补 Key' : '' }}
        </div>
        <div class="preview-foot">
          <button class="btn btn-ghost btn-md" :disabled="busy" @click="backToSource">返回</button>
          <button class="btn btn-default btn-md" data-testid="confirm-import-btn" :disabled="busy || importableCount === 0" @click="applyImport">
            <svg v-if="busy" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
            {{ busy ? '导入中…' : '导入选中' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
}
.import-dialog {
  width: 480px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.import-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.import-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.import-desc {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.import-x {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  flex-shrink: 0;
}
.import-x svg {
  width: 15px;
  height: 15px;
}
.import-x:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.import-x:disabled {
  opacity: 0.5;
}
.import-sources {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.import-source {
  height: 44px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: var(--text-sm);
  color: var(--neutral-fg);
  cursor: pointer;
}
.import-source svg {
  width: 15px;
  height: 15px;
  color: var(--neutral-mid);
}
.import-source:hover:not(:disabled) {
  background: var(--surface-hover);
}
.import-source:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.json-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.json-label {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  font-weight: 500;
}
.json-area {
  width: 100%;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--neutral-fg);
  line-height: 1.7;
  resize: vertical;
  outline: none;
}
.json-area:focus {
  box-shadow: 0 0 0 1px var(--accent-ring) inset;
}
.json-box .btn {
  align-self: flex-start;
}
.warn-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.warn-banner svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.preview-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.preview-empty {
  padding: var(--space-4) 0;
  text-align: center;
  font-size: var(--text-sm);
  color: var(--neutral-dim);
}
.preview-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.preview-item.conflict {
  opacity: 0.7;
}
.pi-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.ui-checkbox {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  padding: 0;
}
.ui-checkbox svg {
  width: 10px;
  height: 10px;
}
.ui-checkbox.checked {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.ui-checkbox.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pi-id {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--neutral-fg);
  font-family: var(--font-mono);
}
.pi-proto {
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  font-family: var(--font-mono);
  background: var(--bg-input);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}
.pi-count {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.pi-keywarn {
  color: var(--warn);
  display: inline-flex;
}
.pi-keywarn svg {
  width: 14px;
  height: 14px;
}
.pi-conflict-badge {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
}
.pi-warn-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  cursor: pointer;
  align-self: flex-start;
  padding: 0;
}
.pi-warn-toggle svg {
  width: 12px;
  height: 12px;
  transition: transform var(--duration-fast) var(--ease);
}
.pi-warn-list {
  margin: 2px 0 0 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--text-xs);
  color: var(--warn);
}
.preview-stats {
  display: flex;
  gap: var(--space-3);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.inline-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--text-sm);
}
.inline-error svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.import-success {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--success-soft);
  color: var(--success);
  font-size: var(--text-sm);
}
.preview-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
