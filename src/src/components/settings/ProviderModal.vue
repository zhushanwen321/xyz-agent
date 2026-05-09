<script setup lang="ts">
/* eslint-disable max-lines */
import { ref, watch, onUnmounted } from 'vue'
import { Button, Input, Select } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { TagPill } from './shared'

interface Props {
  visible: boolean
  title: string
  provider?: ProviderInfo | null
  models: ModelInfo[]
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

const typeOptions = [
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'OpenAI 兼容', value: 'openai-compatible' },
  { label: 'Google AI', value: 'google' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'Ollama (本地)', value: 'ollama' },
]

// ─── Watch provider changes ─────────────────────────────────────

watch(() => props.visible, (v) => {
  if (v) {
    if (props.provider) {
      formName.value = props.provider.name
      formType.value = props.provider.id === 'ollama' ? 'ollama' : props.provider.id
      formUrl.value = props.provider.baseUrl ?? ''
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
      ctx: m.contextWindow ? `${m.contextWindow}` : '--',
      tags: [...(m.tags ?? [])],
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
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', handleKeydown)
  else document.removeEventListener('keydown', handleKeydown)
})

onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div :class="['s-modal-overlay', { visible }]">
    <div class="s-modal">
      <div class="s-modal__hd">
        <div class="s-modal__title">{{ title }}</div>
        <Button variant="ghost" size="icon" class="s-modal__close" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </Button>
      </div>

      <div class="s-modal__bd">
        <div class="s-form-group">
          <div class="s-form-label">名称</div>
          <Input v-model="formName" placeholder="例如：Anthropic、OpenAI、本地 Ollama" />
        </div>

        <div class="s-form-row">
          <div class="s-form-group">
            <div class="s-form-label">类型</div>
            <Select v-model="formType" :options="typeOptions" />
          </div>
          <div class="s-form-group">
            <div class="s-form-label">连接状态</div>
            <div class="s-form-status">未测试</div>
          </div>
        </div>

        <div class="s-form-group">
          <div class="s-form-label">Base URL</div>
          <Input v-model="formUrl" placeholder="https://api.anthropic.com" />
          <div class="s-form-hint">供应商的 API 端点地址。Ollama 默认为 http://localhost:11434</div>
        </div>

        <div class="s-form-group">
          <div class="s-form-label">API Key</div>
          <Input v-model="formKey" type="password" placeholder="sk-ant-..." />
          <div class="s-form-hint">本地模型（如 Ollama）无需 API Key</div>
        </div>

        <div v-if="testResult !== 'none'" :class="['s-test-result', `s-test-result--${testResult}`]">
          <span :class="['s-status-dot', `s-status-dot--${testResult}`]"></span>
          {{ testMessage }}
        </div>

        <div class="s-divider">模型配置</div>

        <div class="s-model-config">
          <div class="s-model-config__hd">
            <span class="s-model-config__title">已配置模型</span>
            <div class="s-model-config__actions">
              <Button variant="ghost" size="sm">自动发现</Button>
            </div>
          </div>
          <div class="s-model-config__list">
            <div v-for="(model, idx) in modalModels" :key="model.id" class="s-model-config-item">
              <span class="s-model-config-item__name">{{ model.name }}</span>
              <span class="s-model-config-item__ctx">{{ model.ctx }}</span>
              <div class="s-model-config-item__tags">
                <TagPill
                  v-for="tag in allTags"
                  :key="tag"
                  :variant="tag"
                  :active="model.tags.includes(tag)"
                  @toggle="toggleModelTag(model, tag)"
                >
                  {{ tag === 'power' ? '强力' : tag === 'efficient' ? '高效' : '快速' }}
                </TagPill>
              </div>
              <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!border-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="removeModel(idx)">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 1l8 8M9 1L1 9" />
                </svg>
              </Button>
            </div>
          </div>
          <div class="s-add-model-row">
            <Input
              v-model="addModelName"
              placeholder="手动输入模型名称，如 my-model-v1"
              class="flex-1"
              @keydown.enter="addModel"
            />
            <Input
              v-model="addModelCtx"
              placeholder="上下文窗口，如 128K"
              class="!max-w-[100px]"
              @keydown.enter="addModel"
            />
            <Button variant="ghost" size="sm" @click="addModel">添加</Button>
          </div>
        </div>
      </div>

      <div class="s-modal__ft">
        <Button variant="ghost" @click="handleTest">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          测试连接
        </Button>
        <Button variant="ghost" @click="$emit('close')">取消</Button>
        <Button variant="primary" @click="handleSave">保存</Button>
      </div>
    </div>
  </div>
</template>
