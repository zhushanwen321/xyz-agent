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
  providerId?: string
}

const formName = ref('')
const formType = ref('anthropic')
const formUrl = ref('')
const formKey = ref('')
const testResult = ref<'none' | 'ok' | 'err'>('none')
const testMessage = ref('')
const modalModels = ref<ModalModel[]>([])

// ─── Auto-discover state ────────────────────────────────────────

const discoverStatus = ref<'idle' | 'loading' | 'error' | 'empty' | 'success'>('idle')
const discoverMessage = ref('')
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
      formType.value = props.provider.type ?? (props.provider.id === 'ollama' ? 'ollama' : props.provider.id)
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
    discoverStatus.value = 'idle'
    discoverMessage.value = ''
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

// ─── Auto-discover ─────────────────────────────────────────────

const DISCOVERY_DELAY_MS = 1500

interface DiscoveredModel {
  id: string
  name: string
  ctx: string
}

const typeModelMap: Record<string, DiscoveredModel[]> = {
  anthropic: [
    { id: 'claude-sonnet-4', name: 'claude-sonnet-4', ctx: '128K' },
    { id: 'claude-opus-4', name: 'claude-opus-4', ctx: '200K' },
    { id: 'claude-haiku-4', name: 'claude-haiku-4', ctx: '128K' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'gpt-4o', ctx: '128K' },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini', ctx: '128K' },
    { id: 'o3', name: 'o3', ctx: '200K' },
  ],
  deepseek: [
    { id: 'deepseek-v4', name: 'deepseek-v4', ctx: '128K' },
    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', ctx: '128K' },
  ],
  google: [
    { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', ctx: '1M' },
    { id: 'gemini-2.5-flash', name: 'gemini-2.5-flash', ctx: '1M' },
  ],
  ollama: [
    { id: 'qwen3-32b', name: 'qwen3:32b', ctx: '32K' },
    { id: 'llama3-70b', name: 'llama3:70b', ctx: '32K' },
  ],
}

function handleDiscover() {
  discoverStatus.value = 'loading'
  discoverMessage.value = ''

  const type = formType.value
  const baseUrl = formUrl.value.trim()

  // 没有填写 URL
  if (!baseUrl && type !== 'openai-compatible') {
    const typeHint: Record<string, string> = {
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com',
      deepseek: 'https://api.deepseek.com',
      google: 'https://generativelanguage.googleapis.com',
      ollama: 'http://localhost:11434',
    }
    setTimeout(() => {
      discoverStatus.value = 'error'
      discoverMessage.value = typeHint[type] ? `请先填写 Base URL（如 ${typeHint[type]}）` : '请先填写 Base URL'
    }, DISCOVERY_DELAY_MS)
    return
  }

  // API Key 为空且非本地模型
  const key = formKey.value.trim()
  if (!key || key === '••••••••') {
    if (type !== 'ollama' && type !== 'openai-compatible') {
      setTimeout(() => {
        discoverStatus.value = 'error'
        discoverMessage.value = '请先填写 API Key'
      }, DISCOVERY_DELAY_MS)
      return
    }
  }

  // 模拟网络请求延迟
  setTimeout(() => {
    const models = typeModelMap[type]
    if (models) {
      // 成功发现模型
      modalModels.value = models.map(m => ({
        id: m.id,
        name: m.name,
        ctx: m.ctx,
        tags: [],
      }))
      discoverStatus.value = 'success'
      discoverMessage.value = `发现 ${models.length} 个可用模型`
    } else if (type === 'openai-compatible') {
      // OpenAI 兼容类型：模拟发现失败（返回空）
      discoverStatus.value = 'empty'
      discoverMessage.value = '未发现可用模型，请确保 Base URL 正确或手动添加'
    } else {
      discoverStatus.value = 'empty'
      discoverMessage.value = '未发现可用模型'
    }
  }, DISCOVERY_DELAY_MS)
}

function handleSave() {
  emit('save', {
    name: formName.value,
    type: formType.value,
    url: formUrl.value,
    key: formKey.value,
    models: [...modalModels.value],
    providerId: props.provider?.id,
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
        <Button variant="ghost" class="s-modal__close !h-7 !w-7 !p-0" @click="$emit('close')">×</Button>
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
              <span v-if="discoverStatus !== 'idle'" :class="['s-discover-msg', `s-discover-msg--${discoverStatus}`]">
                <template v-if="discoverStatus === 'loading'">正在发现…</template>
                <template v-else>{{ discoverMessage }}</template>
              </span>
              <Button
                variant="outline"
                size="sm"
                :disabled="discoverStatus === 'loading'"
                @click="handleDiscover"
              >
                {{ discoverStatus === 'loading' ? '发现中…' : '自动发现' }}
              </Button>
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
              <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="removeModel(idx)">
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
            <Button variant="outline" size="sm" @click="addModel">添加</Button>
          </div>
        </div>
      </div>

      <div class="s-modal__ft">
        <Button variant="outline" @click="handleTest">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          测试连接
        </Button>
        <Button variant="outline" @click="$emit('close')">取消</Button>
        <Button variant="primary" @click="handleSave">保存</Button>
      </div>
    </div>
  </div>
</template>
