<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Select } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
// TagPill removed — tags no longer used
import { useProvider } from '../../composables/useProvider'
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
// ─── Auto-discover state ────────────────────────────────────────

const DEFAULT_NEW_MODEL_CTX = 200_000
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
    contextWindow: Number(addModelCtx.value) || DEFAULT_NEW_MODEL_CTX,
    thinkingLevelMap: structuredClone(THINKING_PRESETS['on-off']),
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
          thinkingLevelMap: existing?.thinkingLevelMap ?? structuredClone(THINKING_PRESETS['on-off']),
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

// ─── Thinking strategy presets ────────────────────────────────

type ThinkingStrategy = 'all-levels' | 'on-off' | 'high-max'

const THINKING_PRESETS: Record<ThinkingStrategy, Record<string, string | null> | undefined> = {
  'all-levels': undefined,
  'on-off': { minimal: null, low: null, medium: null, high: null, xhigh: 'xhigh' },
  'high-max': { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
}

const STRATEGY_LABELS: Record<ThinkingStrategy, string> = {
  'all-levels': 'All Levels',
  'on-off': 'On / Off',
  'high-max': 'high / max',
}

function getStrategyFromMap(map?: Record<string, string | null>): ThinkingStrategy {
  if (!map) return 'all-levels'
  if (map.xhigh === 'max') return 'high-max'
  return 'on-off'
}

function applyThinkingStrategy(model: ModalModel, strategy: ThinkingStrategy) {
  const preset = THINKING_PRESETS[strategy]
  model.thinkingLevelMap = preset ? structuredClone(preset) : undefined
}

const editingModelId = ref<string | null>(null)

function toggleModelEdit(modelId: string) {
  editingModelId.value = editingModelId.value === modelId ? null : modelId
}

function pickStrategy(model: ModalModel, strategy: ThinkingStrategy) {
  applyThinkingStrategy(model, strategy)
  editingModelId.value = null
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (editingModelId.value) {
      editingModelId.value = null
      return
    }
    emit('close')
  }
}

watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', handleKeydown)
  else {
    document.removeEventListener('keydown', handleKeydown)
    editingModelId.value = null
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
            <div
              v-for="(model, idx) in modalModels"
              :key="model.id"
              :class="['model-row', { editing: editingModelId === model.id }]"
              @click="toggleModelEdit(model.id)"
            >
              <span class="model-name font-mono text-xs font-semibold">{{ model.name }}</span>
              <div class="col-badge">
                <!-- Inline pills (visible when editing) -->
                <div class="strategy-pills">
                  <button
                    v-for="s in (['all-levels', 'on-off', 'high-max'] as const)"
                    :key="s"
                    :class="['pill', { 'pill--default active': getStrategyFromMap(model.thinkingLevelMap) === 'all-levels', 'pill--binary active': getStrategyFromMap(model.thinkingLevelMap) === 'on-off', 'pill--highmax active': getStrategyFromMap(model.thinkingLevelMap) === 'high-max' }]"
                    @click.stop="pickStrategy(model, s)"
                  >{{ s === 'all-levels' ? 'All' : s === 'on-off' ? 'O/O' : 'H/M' }}</button>
                </div>
                <!-- Badge (visible when not editing) -->
                <span
                  :class="['badge', {
                    'badge--default': getStrategyFromMap(model.thinkingLevelMap) === 'all-levels',
                    'badge--binary': getStrategyFromMap(model.thinkingLevelMap) === 'on-off',
                    'badge--highmax': getStrategyFromMap(model.thinkingLevelMap) === 'high-max',
                  }]"
                >{{ STRATEGY_LABELS[getStrategyFromMap(model.thinkingLevelMap)] }}</span>
              </div>
              <span class="col-ctx">{{ formatCtx(model.contextWindow) }}</span>
              <div class="col-remove">
                <Button variant="ghost" size="sm" class="hover:!text-[var(--danger)] hover:!bg-[var(--danger-light)]" @click.stop="removeModel(idx)">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1l8 8M9 1L1 9" /></svg>
                </Button>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2 py-2.5 px-3.5 bg-bg border-t border-border">
            <Input
              v-model="addModelName"
              :placeholder="t('settings.manualInputModel')"
              class="flex-1"
              @keydown.enter="addModel"
            />
            <span class="badge badge--binary" style="width:56px;font-size:9px">On / Off</span>
            <Select
              v-model="addModelCtx"
              :options="ctxOptions"
              class="!max-w-[100px]"
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

<style scoped>
/* Fixed column layout */
.model-row {
  display: flex;
  align-items: center;
  gap: 0;
  border-bottom: 1px solid var(--divider);
  transition: background 120ms ease;
  cursor: pointer;
}
.model-row:last-child { border-bottom: none; }
.model-row:hover { background: var(--hover-bg); }

.model-name {
  flex: 1;
  min-width: 0;
  padding: 7px 0 7px 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-badge {
  width: 80px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.col-ctx {
  width: 48px;
  flex-shrink: 0;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  padding-right: 8px;
}
.col-remove {
  width: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Badge */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  padding: 2px 0;
  border-radius: 100px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 100ms ease;
}
.badge--default { background: var(--section-bg); color: var(--muted); border-color: var(--border); }
.badge--default:hover { border-color: var(--accent); color: var(--accent); }
.badge--binary { background: var(--agent-light); color: var(--agent); }
.badge--binary:hover { opacity: 0.8; }
.badge--highmax { background: var(--accent-light); color: var(--accent); }
.badge--highmax:hover { opacity: 0.8; }

/* Inline pills (hidden by default, shown when editing) */
.strategy-pills {
  display: none;
  align-items: center;
  gap: 2px;
}
.model-row.editing .strategy-pills { display: flex; }
.model-row.editing .badge { display: none; }

.pill {
  width: 24px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 100px;
  border: 1px solid transparent;
  transition: all 100ms ease;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
}
.pill:hover { border-color: var(--border); }
.pill--default.active { background: var(--section-bg); color: var(--fg); border-color: var(--border); }
.pill--binary.active { background: var(--agent-light); color: var(--agent); }
.pill--highmax.active { background: var(--accent-light); color: var(--accent); }
</style>
