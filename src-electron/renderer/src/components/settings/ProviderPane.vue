<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { useProviderStore } from '../../stores/provider'
import { useProvider } from '../../composables/useProvider'
import ProviderSection from './ProviderSection.vue'
import ProviderModal from './ProviderModal.vue'

const { t } = useI18n()

const providerStore = useProviderStore()
const { setProvider, deleteProvider } = useProvider()

const providers = computed(() => providerStore.providers)
const models = computed(() => providerStore.models)
const showModal = ref(false)
const editingProvider = ref<ProviderInfo | null>(null)

const modalTitle = computed(() =>
  editingProvider.value ? t('settings.editProvider') : t('settings.addProvider'),
)

const editingModels = computed<ModelInfo[]>(() => {
  if (!editingProvider.value) return []
  return models.value.filter(m => m.providerId === editingProvider.value!.id)
})

function getModelsFor(providerId: string): ModelInfo[] {
  return models.value.filter(m => m.providerId === providerId)
}

function openEdit(id: string) {
  const p = providers.value.find(p => p.id === id)
  if (p) {
    editingProvider.value = p
    showModal.value = true
  }
}

function handleDelete(id: string) {
  deleteProvider(id)
}

function toggleProvider(id: string) {
  const p = providers.value.find(p => p.id === id)
  if (!p) return
  const newEnabled = p.enabled !== false
  providerStore.updateProvider(id, { enabled: !newEnabled })
  setProvider(id, { enabled: !newEnabled })
}

function handleSave(data: {
  name: string
  type: string
  url: string
  key: string
  models: { id: string; name: string; contextWindow?: number; thinkingLevelMap?: Record<string, string | null> }[]
  providerId?: string
}) {
  const { providerId: _pid, ...rest } = data
  const providerId = _pid || data.name.toLowerCase().replace(/\s+/g, '-')
  const { url, key, ...configData } = rest
  const apiKey = key && key !== '••••••••' ? key : undefined
  try {
    setProvider(providerId, {
      ...(apiKey !== undefined && { apiKey }),
      ...(url && { baseUrl: url }),
      ...configData,
    })
    showModal.value = false
    editingProvider.value = null
  } catch (e: unknown) {
    console.error('Failed to save provider:', e)
    return
  }
}
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="flex items-center justify-between mb-7">
      <div>
        <div class="font-display text-[22px] font-bold tracking-tight">{{ t('settings.providers') }}</div>
        <div class="text-[12px] text-muted mt-1">{{ t('settings.providerDesc') }}</div>
      </div>
      <Button
        variant="primary"
        @click="editingProvider = null; showModal = true"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        {{ t('common.create') }}
      </Button>
    </div>

    <!-- Empty state -->
    <div v-if="providers.length === 0" class="flex flex-col items-center justify-center py-20 px-10 text-center">
      <div class="mb-4 w-16 h-16 rounded-full bg-surface border-2 border-dashed border-border flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-7 h-7 text-muted">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      </div>
      <div class="text-base font-semibold mb-1.5">{{ t('settings.noProviders') }}</div>
      <div class="text-[13px] text-muted max-w-[360px] mb-6">{{ t('settings.noProvidersHint') }}</div>
      <Button
        variant="primary"
        @click="editingProvider = null; showModal = true"
      >
        {{ t('settings.addFirstProvider') }}
      </Button>
    </div>

    <!-- Provider sections -->
    <template v-else>
      <ProviderSection
        v-for="provider in providers"
        :key="provider.id"
        :provider="provider"
        :models="getModelsFor(provider.id)"
        @toggle-enabled="toggleProvider"
        @edit="openEdit"
        @delete="handleDelete"
      />
    </template>

    <ProviderModal
      :visible="showModal"
      :title="modalTitle"
      :provider="editingProvider"
      :models="editingModels"
      @close="showModal = false"
      @save="handleSave"
      @test="() => {}"
    />
  </div>
</template>
