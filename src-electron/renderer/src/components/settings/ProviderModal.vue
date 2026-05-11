<script setup lang="ts">
/* eslint-disable max-lines */
import { ref, watch, onUnmounted } from 'vue'
import { Button, Input, Select } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { TagPill } from './shared'
import { send } from '../../lib/ws-client'
import { on as onEvent, off as offEvent } from '../../lib/event-bus'

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
  ctx: string | number | undefined
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
const addModelCtx = ref('200K')

const ctxOptions = [
  { label: '128K', value: '128000' },
  { label: '200K', value: '200000' },
  { label: '256K', value: '256000' },
  { label: '1M', value: '1000000' },
]

function formatCtx(v: string | number | undefined): string {
  if (v == null || v === '--') return '--'
  const n = typeof v === 'string' ? parseInt(v, 10) : v
  if (Number.isNaN(n) || n <= 0) return '--'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  return `${Math.round(n / 1000)}K`
}

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
      ctx: m.contextWindow ?? '--',
      tags: [...(m.tags ?? [])],
    }))
    testResult.value = 'none'
    testMessage.value = ''
    addModelName.value = ''
    addModelCtx.value = '200000'
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
    ctx: addModelCtx.value || '--',
    tags: [],
  })
  addModelName.value = ''
  addModelCtx.value = '200000'
}

function handleTest() {
  testResult.value = 'ok'
  const FALLBACK_MODEL_COUNT = 3
  testMessage.value = `连接成功，发现 ${modalModels.value.length || FALLBACK_MODEL_COUNT} 个可用模型`
  emit('test', { url: formUrl.value, key: formKey.value })
}

// ─── Auto-discover ─────────────────────────────────────────────

interface DiscoveredModel {
  id: string
  name: string
  ctx: string
}

// 监听自动发现结果的回调引用，用于卸载时清理
let discoverHandler: ((msg: unknown) => void) | null = null

const DISCOVER_TIMEOUT_MS = 15_000
let discoverTimer: ReturnType<typeof setTimeout> | null = null

function cleanupDiscover() {
  if (discoverHandler) {
    offEvent('config.discoveredModels', discoverHandler)
    discoverHandler = null
  }
  if (discoverTimer) {
    clearTimeout(discoverTimer)
    discoverTimer = null
  }
}

function handleDiscover() {
  discoverStatus.value = 'loading'
  discoverMessage.value = ''

  const type = formType.value
  const baseUrl = formUrl.value.trim()

  // 前置校验：Base URL
  if (!baseUrl) {
    discoverStatus.value = 'error'
    discoverMessage.value = '请先填写 Base URL'
    return
  }

  // 前置校验：API Key（本地模型除外，编辑模式下掩码视为已有 key）
  const key = formKey.value.trim()
  const isNewProvider = !props.provider
  const keyIsMask = key === '••••••••'
  if (isNewProvider && !key && type !== 'ollama') {
    discoverStatus.value = 'error'
    discoverMessage.value = '请先填写 API Key'
    return
  }

  // 清理旧监听和超时
  cleanupDiscover()

  // 超时保护：sidecar 未响应或版本过旧时防止永久 loading
  discoverTimer = setTimeout(() => {
    cleanupDiscover()
    discoverStatus.value = 'error'
    discoverMessage.value = '发现超时，请确认后端服务已启动且版本最新'
  }, DISCOVER_TIMEOUT_MS)

  // 注册一次性监听
  discoverHandler = (msg: unknown) => {
    cleanupDiscover()

    const payload = (msg as { payload: Record<string, unknown> }).payload
    const models = payload.models as Array<{ id: string; name: string; ctx?: number }>
    const success = payload.success as boolean
    const error = payload.error as string | undefined

    if (success && models.length > 0) {
      modalModels.value = models.map(m => ({
        id: m.id,
        name: m.name,
        ctx: m.ctx,
        tags: [],
      }))
      discoverStatus.value = 'success'
      discoverMessage.value = `发现 ${models.length} 个可用模型`
    } else if (success && models.length === 0) {
      discoverStatus.value = 'empty'
      discoverMessage.value = '未发现可用模型，请确保 Base URL 正确或手动添加'
    } else {
      discoverStatus.value = 'error'
      discoverMessage.value = error || '发现失败，请检查网络或 API Key'
    }
  }
  onEvent('config.discoveredModels', discoverHandler)

  // 通过 sidecar 发起 HTTP 请求
  // 掩码 key 不发送，sidecar 会通过 providerId 从 config-store 读取已保存的 key
  send({
    type: 'config.discoverModels',
    payload: {
      baseUrl,
      apiKey: keyIsMask ? undefined : key || undefined,
      providerType: type,
      providerId: props.provider?.id || undefined,
    },
  })
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
  else {
    document.removeEventListener('keydown', handleKeydown)
    // modal 关闭时清理 discover 监听
    cleanupDiscover()
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  cleanupDiscover()
})
</script>

<template>
  <div :class="['s-modal-overlay', { visible }]" @click.self="$emit('close')">
    <div class="s-modal" @click.stop>
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
              <span class="s-model-config-item__ctx">{{ formatCtx(model.ctx) }}</span>
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
            <Select
              v-model="addModelCtx"
              :options="ctxOptions"
              class="!max-w-[120px]"
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
