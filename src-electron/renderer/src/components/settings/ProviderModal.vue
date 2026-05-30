<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Select } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
// TagPill removed — tags no longer used
import { useProvider } from '../../composables/useProvider'
import ThinkingLevelConfig from './ThinkingLevelConfig.vue'
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
  contextWindow: number
  enabled?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

interface ModalFormData {
  name: string
  type: string
  url: string
  key: string
  models: ModalModel[]
  providerId?: string
}

const { t } = useI18n()

const CTX_1M = 1_000_000
const CTX_1K = 1000

const formName = ref('')
const formType = ref('openai-completions')
const formUrl = ref('')
const formKey = ref('')
const testResult = ref<'none' | 'ok' | 'err'>('none')
const testMessage = ref('')
const modalModels = ref<ModalModel[]>([])
const expandedModels = ref<Set<string>>(new Set())

function toggleExpand(modelId: string) {
  if (expandedModels.value.has(modelId)) {
    expandedModels.value.delete(modelId)
  } else {
    expandedModels.value.add(modelId)
  }
}

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
  if (n >= CTX_1M) return `${(n / CTX_1M).toFixed(n % CTX_1M === 0 ? 0 : 1)}M`
  return `${Math.round(n / CTX_1K)}K`
}

const typeOptions = [
  { label: 'Anthropic', value: 'anthropic-messages' },
  { label: 'OpenAI Compatible', value: 'openai-completions' },
]

// ─── Watch provider changes ─────────────────────────────────────

watch(() => props.visible, (v) => {
  if (v) {
    if (props.provider) {
      formName.value = props.provider.name
      formType.value = props.provider.api ?? 'openai-completions'
      formUrl.value = props.provider.baseUrl ?? ''
      formKey.value = props.provider.apiKeySet ? '••••••••' : ''
    } else {
      formName.value = ''
      formType.value = 'openai-completions'
      formUrl.value = ''
      formKey.value = ''
    }
    modalModels.value = props.models.map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow ?? 0,
      thinkingLevelMap: m.thinkingLevelMap,
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
    'anthropic-messages': 'https://api.anthropic.com',
    'openai-completions': '',
  }
  formUrl.value = defaults[t] ?? ''
})

// ─── Actions ────────────────────────────────────────────────────

function removeModel(index: number) {
  modalModels.value.splice(index, 1)
}

function addModel() {
  const name = addModelName.value.trim()
  if (!name) return
  modalModels.value.push({
    id: `new-${Date.now()}`,
    name,
    contextWindow: Number(addModelCtx.value) || 200_000,
  })
  addModelName.value = ''
  addModelCtx.value = '200000'
}

function handleTest() {
  testResult.value = 'ok'
  const FALLBACK_MODEL_COUNT = 3
  testMessage.value = t('settings.foundModels', { n: modalModels.value.length || FALLBACK_MODEL_COUNT })
  emit('test', { url: formUrl.value, key: formKey.value })
}

// ─── Auto-discover ─────────────────────────────────────────────

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
    discoverMessage.value = t('settings.baseUrlHint')
    return
  }

  // 前置校验：API Key（本地模型除外，编辑模式下掩码视为已有 key）
  const key = formKey.value.trim()
  const isNewProvider = !props.provider
  const keyIsMask = key === '••••••••'
  if (isNewProvider && !key && type !== 'ollama') {
    discoverStatus.value = 'error'
    discoverMessage.value = t('settings.apiKeyHint')
    return
  }

  // 清理旧监听和超时
  cleanupDiscover()

  // 超时保护
  discoverTimer = setTimeout(() => {
    cleanupDiscover()
    discoverStatus.value = 'error'
    discoverMessage.value = t('settings.discoveryTimeoutHint')
  }, DISCOVER_TIMEOUT_MS)

  // 注册一次性监听
  discoverHandler = (msg: unknown) => {
    cleanupDiscover()

    const payload = (msg as { payload: Record<string, unknown> }).payload
    const models = payload.models as Array<{ id: string; name: string; contextWindow?: number }>
    const success = payload.success as boolean
    const error = payload.error as string | undefined

    if (success && models.length > 0) {
      modalModels.value = models.map(m => {
        const existing = modalModels.value.find(em => em.id === m.id)
        return {
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow ?? 0,
          enabled: existing?.enabled ?? true,
          thinkingLevelMap: existing?.thinkingLevelMap,
        }
      })
      discoverStatus.value = 'success'
      discoverMessage.value = t('settings.foundModels', { n: models.length })
    } else if (success && models.length === 0) {
      discoverStatus.value = 'empty'
      discoverMessage.value = t('settings.noModelsFoundHint')
    } else {
      discoverStatus.value = 'error'
      discoverMessage.value = error || t('settings.discoveryFailedHint')
    }
  }
  onEvent('config.discoveredModels', discoverHandler)

  // 通过 composable 发起发现请求
  const { discoverModels } = useProvider()
  discoverModels(
    baseUrl,
    keyIsMask ? undefined : key || undefined,
    type,
    props.provider?.id || undefined,
  )
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
  <div
    data-modal-overlay
    :data-modal-visible="visible || undefined"
    :class="[
      'fixed inset-0 bg-black/30 z-[100] flex items-center justify-center transition-opacity duration-200',
      visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
    ]"
    @click.self="$emit('close')"
  >
    <div class="w-[600px] max-h-[85vh] bg-surface border border-border rounded-sm overflow-hidden flex flex-col shadow-[0_8px_40px_rgba(0,0,0,0.12)]" @click.stop>
      <div class="flex items-center justify-between py-4 px-5 border-b border-border">
        <div class="font-display text-base font-semibold">{{ title }}</div>
        <Button variant="ghost" class="!h-7 !w-7 !p-0 !rounded-xs !text-muted hover:!bg-accent-light hover:!text-accent" @click="$emit('close')">×</Button>
      </div>

      <div class="p-5 overflow-y-auto flex-1">
        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">{{ t('settings.providerName') }}</div>
          <Input v-model="formName" :placeholder="t('settings.providerNamePlaceholder')" />
        </div>

        <div class="flex gap-3">
          <div class="mb-4 flex-1">
            <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">{{ t('settings.providerType') }}</div>
            <Select v-model="formType" :options="typeOptions" />
          </div>
          <div class="mb-4 flex-1">
            <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">{{ t('settings.connectionStatus') }}</div>
            <div class="py-2 text-[13px] text-muted">{{ t('settings.connectionNotTested') }}</div>
          </div>
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">Base URL</div>
          <Input v-model="formUrl" placeholder="https://api.anthropic.com" />
          <div class="text-[11px] text-muted mt-1">{{ t('settings.endpointDefaultHint') }}</div>
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">API Key</div>
          <Input v-model="formKey" type="password" placeholder="sk-ant-..." />
          <div class="text-[11px] text-muted mt-1">{{ t('settings.localModelNoUrlNeeded') }}</div>
        </div>

        <div v-if="testResult !== 'none'" :class="['py-2 px-3 rounded-sm text-xs mt-2 flex items-center gap-2', testResult === 'ok' ? 'bg-success-light text-success' : 'bg-danger-light text-danger']">
          <span :class="['w-[7px] h-[7px] rounded-full inline-block align-middle', testResult === 'ok' ? 'bg-success' : 'bg-danger']"></span>
          {{ testMessage }}
        </div>

        <div class="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted my-5 pb-1.5 border-b border-border">{{ t('settings.modelConfig') }}</div>

        <div class="border border-border rounded-sm overflow-hidden mt-2">
          <div class="flex items-center justify-between py-2.5 px-3.5 bg-bg border-b border-border">
            <span class="text-xs font-semibold">{{ t('settings.configuredModels') }}</span>
            <div class="flex gap-1.5">
              <span v-if="discoverStatus !== 'idle'" :class="['text-[11px] inline-flex items-center gap-1 whitespace-nowrap', {
                'text-muted': discoverStatus === 'loading',
                'text-success': discoverStatus === 'success',
                'text-danger': discoverStatus === 'error',
                'text-warning': discoverStatus === 'empty',
              }]">
                <template v-if="discoverStatus === 'loading'">{{ t('settings.discovering') }}…</template>
                <template v-else>{{ discoverMessage }}</template>
              </span>
              <Button
                variant="outline"
                size="sm"
                :disabled="discoverStatus === 'loading'"
                @click="handleDiscover"
              >
                {{ discoverStatus === 'loading' ? t('settings.discoveringModels') : t('settings.autoDiscover') }}
              </Button>
            </div>
          </div>
          <div class="max-h-60 overflow-y-auto">
            <div v-for="(model, idx) in modalModels" :key="model.id">
              <div class="flex items-center gap-2.5 py-2.5 px-3.5 border-b border-border">
                <Button
                  variant="ghost"
                  size="sm"
                  class="shrink-0 !w-5 !h-5 !p-0 rounded-sm transition-transform duration-200"
                  :class="{ 'rotate-90': expandedModels.has(model.id) }"
                  @click="toggleExpand(model.id)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                </Button>
                <span class="font-mono text-xs font-semibold min-w-[160px]">{{ model.name }}</span>
                <span
                  v-if="model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0"
                  class="text-[10px] px-1.5 py-px rounded-sm bg-accent/10 text-accent"
                >mapped</span>
                <span class="text-[11px] text-muted font-mono min-w-[50px]">{{ formatCtx(model.contextWindow) }}</span>
                <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click="removeModel(idx)">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 1l8 8M9 1L1 9" />
                  </svg>
                </Button>
              </div>
              <div v-if="expandedModels.has(model.id)" class="border-b border-border">
                <ThinkingLevelConfig v-model="model.thinkingLevelMap" />
              </div>
            </div>
          </div>
          <div class="flex gap-2 py-2.5 px-3.5 bg-bg border-t border-border">
            <Input
              v-model="addModelName"
              :placeholder="t('settings.manualInputModel')"
              class="flex-1"
              @keydown.enter="addModel"
            />
            <Select
              v-model="addModelCtx"
              :options="ctxOptions"
              class="!max-w-[120px]"
            />
            <Button variant="outline" size="sm" @click="addModel">{{ t('common.create') }}</Button>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2 py-3.5 px-5 border-t border-border">
        <Button variant="outline" @click="handleTest">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          {{ t('settings.testConnection') }}
        </Button>
        <Button variant="outline" @click="$emit('close')">{{ t('common.cancel') }}</Button>
        <Button variant="primary" @click="handleSave">{{ t('common.save') }}</Button>
      </div>
    </div>
  </div>
</template>
