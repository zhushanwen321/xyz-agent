<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { Button, Input, Select } from '../../design-system'

const props = withDefaults(defineProps<{
  provider: ProviderInfo | null
  models: ModelInfo[]
  isEdit: boolean
}>(), {
  provider: null,
  models: () => [],
  isEdit: false,
})

const emit = defineEmits<{
  save: [payload: { providerId: string; apiKey: string; baseUrl?: string }]
  cancel: []
  delete: [providerId: string]
}>()

const { t } = useI18n()

const providerName = ref(props.provider?.name ?? '')
const apiKey = ref('')
const baseUrl = ref(props.provider?.baseUrl ?? '')

const DEFAULT_TEMPERATURE = 0.7

const modelOptions = computed(() => {
  const base = [{ label: t('settings.noDefaultModel'), value: '' }]
  const opts = props.models.map(m => ({ label: m.name, value: m.id }))
  return [...base, ...opts]
})

const thinkingOptions = computed(() => [
  { label: t('settings.thinkingHigh'), value: 'high' },
  { label: t('settings.thinkingMedium'), value: 'medium' },
  { label: t('settings.thinkingLow'), value: 'low' },
  { label: t('settings.thinkingNone'), value: 'none' },
])

const defaultModel = ref('')
const thinkingMode = ref('none')
const temperature = ref(DEFAULT_TEMPERATURE)

const canSave = computed(() => {
  if (props.isEdit) return true // editing existing, apiKey change optional
  return providerName.value.trim().length > 0 && apiKey.value.trim().length > 0
})

function handleSave() {
  emit('save', {
    providerId: props.provider?.id ?? providerName.value.toLowerCase().replace(/\s+/g, '-'),
    apiKey: apiKey.value,
    baseUrl: baseUrl.value.trim() || undefined,
  })
}
</script>

<template>
  <div class="provider-form">
    <h3 class="provider-form__title">
      {{ isEdit ? t('settings.editProvider') : t('settings.addProvider') }}
    </h3>

    <div class="provider-form__fields">
      <Input
        v-model="providerName"
        :label="t('settings.providerName')"
        :placeholder="t('settings.providerNamePlaceholder')"
        :disabled="isEdit"
      />

      <Input
        v-model="apiKey"
        type="password"
        :label="t('settings.apiKey')"
        :placeholder="isEdit ? t('settings.apiKeyPlaceholderEdit') : t('settings.apiKeyPlaceholder')"
      />
      <span class="provider-form__hint">{{ t('settings.apiKeyHint') }}</span>

      <Input
        v-model="baseUrl"
        :label="t('settings.baseUrl')"
        :placeholder="t('settings.baseUrlPlaceholder')"
      />
      <span class="provider-form__hint">{{ t('settings.baseUrlHint') }}</span>

      <div class="provider-form__field">
        <label class="provider-form__label">{{ t('settings.defaultModel') }}</label>
        <Select
          v-model="defaultModel"
          :options="modelOptions"
          :placeholder="t('settings.selectModel')"
        />
      </div>

      <div class="provider-form__field">
        <label class="provider-form__label">{{ t('settings.thinkingMode') }}</label>
        <Select
          v-model="thinkingMode"
          :options="thinkingOptions"
          :placeholder="t('settings.thinkingMode')"
        />
      </div>

      <div class="provider-form__field">
        <label class="provider-form__label">
          {{ t('settings.temperature') }}: {{ temperature.toFixed(1) }}
        </label>
        <!-- eslint-disable-next-line taste/no-native-html-elements -- range slider has no design-system replacement -->
        <input
          v-model.number="temperature"
          type="range"
          min="0"
          max="2"
          step="0.1"
          class="provider-form__range"
        />
      </div>
    </div>

    <div class="provider-form__actions">
      <Button variant="ghost" size="md" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </Button>
      <Button v-if="isEdit" variant="danger" size="md" @click="provider && emit('delete', provider.id)">
        {{ t('common.delete') }}
      </Button>
      <Button variant="primary" size="md" :disabled="!canSave" @click="handleSave">
        {{ t('common.save') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.provider-form {
  display: flex;
  flex-direction: column;
  gap: var(--radius-lg, 12px);
}

.provider-form__title {
  font-size: var(--font-lg, 1.125rem);
  font-weight: 600;
  color: var(--fg);
  margin: 0;
}

.provider-form__fields {
  display: flex;
  flex-direction: column;
  gap: var(--radius-md, 8px);
}

.provider-form__hint {
  font-size: var(--font-xs, 0.75rem);
  color: var(--muted);
  margin-top: calc(-1 * var(--radius-xs, 4px));
}

.provider-form__field {
  display: flex;
  flex-direction: column;
  gap: var(--radius-xs, 4px);
}

.provider-form__label {
  font-size: var(--font-sm, 0.875rem);
  font-weight: 500;
  color: var(--fg);
}

.provider-form__range {
  width: 100%;
  accent-color: var(--accent);
}

.provider-form__actions {
  display: flex;
  align-items: center;
  gap: var(--radius-sm, 4px);
  justify-content: flex-end;
  padding-top: var(--radius-md, 8px);
  border-top: 1px solid var(--border);
}
</style>
