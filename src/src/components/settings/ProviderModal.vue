<script setup lang="ts">
/* eslint-disable max-lines */
import { ref, watch } from 'vue'
import type { MockProvider, MockModel } from '../../mock/data'
import { TagPill } from './shared'

interface Props {
  visible: boolean
  title: string
  provider?: MockProvider | null
  models: MockModel[]
}

const props = withDefaults(defineProps<Props>(), {
  provider: null,
})

const emit = defineEmits<{
  close: []
  save: [data: ModalFormData]
  test: [data: { url: string; key: string }]
}>()

// ─── Form state ─────────────────────────────────────────────────

interface ModalModel {
  id: string
  name: string
  ctx: string
  tags: string[]
}

interface ModalFormData {
  name: string
  type: string
  url: string
  key: string
  models: ModalModel[]
}

const formName = ref('')
const formType = ref('anthropic')
const formUrl = ref('')
const formKey = ref('')
const testResult = ref<'none' | 'ok' | 'err'>('none')
const testMessage = ref('')
const modalModels = ref<ModalModel[]>([])
const addModelName = ref('')
const addModelCtx = ref('')

const allTags = ['power', 'efficient', 'fast'] as const

// ─── Watch provider changes ─────────────────────────────────────

watch(() => props.visible, (v) => {
  if (v) {
    if (props.provider) {
      formName.value = props.provider.name
      formType.value = props.provider.id === 'ollama' ? 'ollama' : props.provider.id
      formUrl.value = props.provider.baseUrl
      formKey.value = props.provider.apiKeySet ? '••••••••' : ''
    } else {
      formName.value = ''
      formType.value = 'anthropic'
      formUrl.value = ''
      formKey.value = ''
    }
    modalModels.value = props.models.map(m => ({
      id: m.id,
      name: m.name,
      ctx: m.ctx,
      tags: [...m.tags],
    }))
    testResult.value = 'none'
    testMessage.value = ''
    addModelName.value = ''
    addModelCtx.value = ''
  }
})

watch(formType, (t) => {
  if (formUrl.value) return
  const defaults: Record<string, string> = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    'openai-compatible': '',
    google: 'https://generativelanguage.googleapis.com',
    deepseek: 'https://api.deepseek.com',
    ollama: 'http://localhost:11434',
  }
  formUrl.value = defaults[t] ?? ''
})

// ─── Actions ────────────────────────────────────────────────────

function removeModel(index: number) {
  modalModels.value.splice(index, 1)
}

function toggleModelTag(model: ModalModel, tag: string) {
  const idx = model.tags.indexOf(tag)
  if (idx >= 0) model.tags.splice(idx, 1)
  else model.tags.push(tag)
}

function addModel() {
  const name = addModelName.value.trim()
  if (!name) return
  modalModels.value.push({
    id: `new-${Date.now()}`,
    name,
    ctx: addModelCtx.value.trim() || '--',
    tags: [],
  })
  addModelName.value = ''
  addModelCtx.value = ''
}

function handleTest() {
  // P1: static success message
  testResult.value = 'ok'
  const FALLBACK_MODEL_COUNT = 3
  testMessage.value = `连接成功，发现 ${modalModels.value.length || FALLBACK_MODEL_COUNT} 个可用模型`
  emit('test', { url: formUrl.value, key: formKey.value })
}

function handleSave() {
  emit('save', {
    name: formName.value,
    type: formType.value,
    url: formUrl.value,
    key: formKey.value,
    models: [...modalModels.value],
  })
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

// Watch for Escape key when modal is visible
watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', handleKeydown)
  else document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div :class="['modal-overlay', { visible }]">
    <div class="modal">
      <div class="modal__hd">
        <div class="modal__title">{{ title }}</div>
        <button class="modal__close" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>
      </div>

      <div class="modal__bd">
        <div class="form-group">
          <div class="form-group__label">名称</div>
          <input v-model="formName" class="form-input" placeholder="例如：Anthropic、OpenAI、本地 Ollama">
        </div>

        <div class="form-row">
          <div class="form-group">
            <div class="form-group__label">类型</div>
            <select v-model="formType" class="form-select">
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="openai-compatible">OpenAI 兼容</option>
              <option value="google">Google AI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="ollama">Ollama (本地)</option>
            </select>
          </div>
          <div class="form-group">
            <div class="form-group__label">连接状态</div>
            <div class="form-status">未测试</div>
          </div>
        </div>

        <div class="form-group">
          <div class="form-group__label">Base URL</div>
          <input v-model="formUrl" class="form-input" placeholder="https://api.anthropic.com">
          <div class="form-hint">供应商的 API 端点地址。Ollama 默认为 http://localhost:11434</div>
        </div>

        <div class="form-group">
          <div class="form-group__label">API Key</div>
          <input v-model="formKey" class="form-input" type="password" placeholder="sk-ant-...">
          <div class="form-hint">本地模型（如 Ollama）无需 API Key</div>
        </div>

        <div v-if="testResult !== 'none'" :class="['test-result', `test-result--${testResult}`]">
          <span :class="['status-dot', `status-dot--${testResult}`]"></span>
          {{ testMessage }}
        </div>

        <div class="section-divider">模型配置</div>

        <div class="model-config">
          <div class="model-config__hd">
            <span class="model-config__title">已配置模型</span>
            <div class="model-config__actions">
              <button class="btn btn--sm">自动发现</button>
            </div>
          </div>
          <div class="model-config__list">
            <div v-for="(model, idx) in modalModels" :key="model.id" class="model-config-item">
              <span class="model-config-item__name">{{ model.name }}</span>
              <span class="model-config-item__ctx">{{ model.ctx }}</span>
              <div class="model-config-item__tags">
                <TagPill
                  v-for="tag in allTags"
                  :key="tag"
                  :variant="tag"
                  :active="model.tags.includes(tag)"
                  @click="toggleModelTag(model, tag)"
                >
                  {{ tag === 'power' ? '强力' : tag === 'efficient' ? '高效' : '快速' }}
                </TagPill>
              </div>
              <button class="btn btn--ghost btn--sm btn--danger" @click="removeModel(idx)">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 1l8 8M9 1L1 9" />
                </svg>
              </button>
            </div>
          </div>
          <div class="add-model-row">
            <input
              v-model="addModelName"
              class="add-model-row__input"
              placeholder="手动输入模型名称，如 my-model-v1"
              @keydown.enter="addModel"
            >
            <input
              v-model="addModelCtx"
              class="add-model-row__input"
              placeholder="上下文窗口，如 128K"
              style="max-width: 100px"
              @keydown.enter="addModel"
            >
            <button class="btn btn--sm" @click="addModel">添加</button>
          </div>
        </div>
      </div>

      <div class="modal__ft">
        <button class="btn" @click="handleTest">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          测试连接
        </button>
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn btn--primary" @click="handleSave">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Modal overlay */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s var(--ease);
}

.modal-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}

.modal {
  width: 600px;
  max-height: 85vh;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.12);
}

.modal__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal__title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
}

.modal__close {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  border-radius: var(--radius-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s var(--ease);
}

.modal__close:hover {
  background: var(--accent-light);
  color: var(--accent);
}

.modal__bd {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.modal__ft {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}

/* Form */
.form-group {
  margin-bottom: 16px;
}

.form-group__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.form-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s var(--ease);
}

.form-input:focus {
  border-color: var(--accent);
}

.form-input::placeholder {
  color: var(--muted);
}

.form-select {
  appearance: none;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 14px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s var(--ease);
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}

.form-select:focus {
  border-color: var(--accent);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row .form-group {
  flex: 1;
}

.form-hint {
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}

.form-status {
  padding: 8px 0;
  font-size: 13px;
  color: var(--muted);
}

/* Status dots */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  vertical-align: middle;
}

.status-dot--ok {
  background: var(--success);
}

.status-dot--err {
  background: var(--danger);
}

/* Test result */
.test-result {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-result--ok {
  background: var(--success-light);
  color: var(--success);
}

.test-result--err {
  background: var(--danger-light);
  color: var(--danger);
}

/* Section divider */
.section-divider {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 20px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

/* Model config panel */
.model-config {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  margin-top: 8px;
}

.model-config__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.model-config__title {
  font-size: 12px;
  font-weight: 600;
}

.model-config__actions {
  display: flex;
  gap: 6px;
}

.model-config__list {
  max-height: 240px;
  overflow-y: auto;
}

.model-config-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.model-config-item:last-child {
  border-bottom: none;
}

.model-config-item__name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  min-width: 180px;
}

.model-config-item__ctx {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--font-mono);
  min-width: 60px;
}

.model-config-item__tags {
  display: flex;
  gap: 4px;
  flex: 1;
}

.add-model-row {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  background: var(--bg);
  border-top: 1px solid var(--border);
}

.add-model-row__input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--surface);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
}

.add-model-row__input:focus {
  border-color: var(--accent);
}

.add-model-row__input::placeholder {
  color: var(--muted);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.2s var(--ease);
  white-space: nowrap;
}

.btn:hover {
  background: var(--accent-light);
  color: var(--accent);
  border-color: var(--accent);
}

.btn--primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.btn--primary:hover {
  opacity: 0.88;
}

.btn--sm {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: var(--radius-xs);
}

.btn--danger:hover {
  background: var(--danger-light);
  color: var(--danger);
  border-color: var(--danger);
}

.btn--ghost {
  border: none;
  color: var(--muted);
  padding: 5px 8px;
}

.btn--ghost:hover {
  color: var(--accent);
  background: var(--accent-light);
}
</style>
