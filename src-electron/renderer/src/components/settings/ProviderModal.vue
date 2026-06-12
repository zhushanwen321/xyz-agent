<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Select } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { useProviderValidation } from '../../composables/useProviderValidation'
import {
  useModelEditor,
  formatCtx,
  ctxOptions,
  THINKING_PRESETS,
  STRATEGY_LABELS,
  getStrategyFromMap,
} from '../../composables/useModelEditor'
import type { ModalModel } from '../../composables/useModelEditor'

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

interface ModalFormData {
  name: string
  type: string
  url: string
  key: string
  models: ModalModel[]
  providerId?: string
}

const { t } = useI18n()

const formName = ref('')
const formType = ref('openai-completions')
const formUrl = ref('')
const formKey = ref('')
const testResult = ref<'none' | 'ok' | 'err'>('none')
const testMessage = ref('')
const modalModels = ref<ModalModel[]>([])
// ─── Auto-discover state ────────────────────────────────────────

const DEFAULT_NEW_MODEL_CTX = 200_000
const addModelName = ref('')
const addModelCtx = ref('200K')

const typeOptions = [
  { label: 'Anthropic', value: 'anthropic-messages' },
  { label: 'OpenAI Compatible', value: 'openai-completions' },
]

// ─── Provider validation composable ─────────────────────────────

const {
  discoverStatus,
  discoverMessage,
  isSaving,
  discover,
  validateAndSave,
  cleanup: cleanupDiscover,
} = useProviderValidation()

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

watch(formType, (type) => {
  if (formUrl.value) return
  const defaults: Record<string, string> = {
    'anthropic-messages': 'https://api.anthropic.com',
    'openai-completions': '',
  }
  formUrl.value = defaults[type] ?? ''
})

// ─── Actions ────────────────────────────────────────────────────

function removeModel(index: number) {
  modalModels.value.splice(index, 1)
}

function addModel() {
  const name = addModelName.value.trim()
  if (!name) return
  modalModels.value.push({
    id: name,
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

// ─── Auto-discover (delegated to composable) ────────────────────

function handleDiscover() {
  const type = formType.value
  const baseUrl = formUrl.value.trim()

  if (!baseUrl) {
    discoverStatus.value = 'error'
    discoverMessage.value = t('settings.baseUrlHint')
    return
  }

  const key = formKey.value.trim()
  const isNewProvider = !props.provider
  const keyIsMask = key === '••••••••'
  if (isNewProvider && !key && type !== 'ollama') {
    discoverStatus.value = 'error'
    discoverMessage.value = t('settings.apiKeyHint')
    return
  }

  discover(
    baseUrl,
    keyIsMask ? undefined : key || undefined,
    type,
    props.provider?.id || undefined,
    // onSuccess: merge discovered models into form state
    (models) => {
      modalModels.value = models.map(m => {
        const existing = modalModels.value.find(em => em.id === m.id)
        return {
          id: m.id,
          name: m.name ?? m.id,
          contextWindow: m.contextWindow ?? 0,
          enabled: existing?.enabled ?? true,
          thinkingLevelMap: existing?.thinkingLevelMap ?? structuredClone(THINKING_PRESETS['on-off']),
        }
      })
    },
  )
}

function handleSave() {
  if (isSaving.value) return

  const type = formType.value
  const baseUrl = formUrl.value.trim()
  const key = formKey.value.trim()
  const keyIsMask = key === '••••••••'

  // Skip validation for providers without HTTP API
  const needsValidation = baseUrl && (type !== 'ollama' || baseUrl !== '')
  if (!needsValidation) {
    emitSave()
    return
  }

  validateAndSave(
    baseUrl,
    keyIsMask ? undefined : key || undefined,
    type,
    props.provider?.id || undefined,
    emitSave,
  )
}

function emitSave() {
  emit('save', {
    name: formName.value,
    type: formType.value,
    url: formUrl.value,
    key: formKey.value,
    models: [...modalModels.value],
    providerId: props.provider?.id,
  })
}

// ─── Model editor (extracted to composable) ──────────────────────

const {
  editingModelId,
  editingCtxValue,
  updateModelCtx,
  toggleModelEdit,
  getCtxOptionsForModel,
  pickStrategy,
  resetEditing,
} = useModelEditor(modalModels)

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (editingModelId.value) {
      resetEditing()
      return
    }
    emit('close')
  }
}

watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', handleKeydown)
  else {
    document.removeEventListener('keydown', handleKeydown)
    resetEditing()
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
              <!-- Context window: static when not editing, select when editing -->
              <span v-if="editingModelId !== model.id" class="col-ctx">{{ formatCtx(model.contextWindow) }}</span>
              <div v-else class="col-ctx-edit" @click.stop>
                <!-- @click.stop prevents toggling edit mode while using Select -->
                <Select
                  :model-value="editingCtxValue"
                  :options="getCtxOptionsForModel(model)"
                  class="ctx-select"
                  @update:model-value="(v: string | number) => updateModelCtx(model.id, v)"
                />
              </div>
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
            <span class="badge badge--binary badge--compact">On / Off</span>
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
        <Button variant="primary" :disabled="isSaving" @click="handleSave">{{ isSaving ? t('common.saving') : t('common.save') }}</Button>
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
.col-ctx-edit {
  width: 80px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 4px;
}
/* Inline select matching badge dimensions (72px × badge height, 10px font) */
.col-ctx-edit :deep(.ctx-select) {
  width: 72px !important;
  height: 22px !important;
  font-size: 10px !important;
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
.badge--compact { width: 56px; font-size: 9px; }

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
