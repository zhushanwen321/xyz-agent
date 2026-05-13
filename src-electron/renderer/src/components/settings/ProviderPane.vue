<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { useProviderStore } from '../../stores/provider'
import { send } from '../../lib/ws-client'
import ProviderSection from './ProviderSection.vue'
import ProviderModal from './ProviderModal.vue'

const providerStore = useProviderStore()

const providers = computed(() => providerStore.providers)
const models = computed(() => providerStore.models)
const showModal = ref(false)
const editingProvider = ref<ProviderInfo | null>(null)

const modalTitle = computed(() =>
  editingProvider.value ? '编辑供应商' : '添加供应商',
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
  send({ type: 'config.deleteProvider', payload: { providerId: id } })
}

function toggleProvider(id: string) {
  const p = providers.value.find(p => p.id === id)
  if (!p) return
  const newEnabled = p.enabled !== false
  providerStore.updateProvider(id, { enabled: !newEnabled })
  send({ type: 'config.setProvider', payload: { providerId: id, enabled: !newEnabled } })
}

function toggleModel(providerId: string, modelId: string) {
  const m = models.value.find(m => m.id === modelId && m.providerId === providerId)
  if (m) {
    const newEnabled = !m.enabled
    providerStore.updateModel(providerId, modelId, { enabled: newEnabled })
    send({ type: 'model.toggle', payload: { providerId, modelId, enabled: newEnabled } })
  }
}

function handleSave(_data: {
  name: string
  type: string
  url: string
  key: string
  models: { id: string; name: string; ctx: string; tags: string[] }[]
  providerId?: string
}) {
  const { providerId: _pid, ...rest } = _data
  const providerId = _pid || _data.name.toLowerCase().replace(/\s+/g, '-')
  const { url, key, ...configData } = rest
  const apiKey = key && key !== '••••••••' ? key : undefined
  send({ type: 'config.setProvider', payload: { providerId, baseUrl: url, ...(apiKey !== undefined && { apiKey: apiKey }), ...configData } })
  showModal.value = false
  editingProvider.value = null
}
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="flex items-center justify-between mb-7">
      <div>
        <div class="font-display text-[22px] font-bold tracking-tight">Provider 配置</div>
        <div class="text-[12px] text-muted mt-1">管理 AI 模型供应商、API 密钥和模型列表</div>
      </div>
      <Button
        variant="primary"
        @click="editingProvider = null; showModal = true"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        添加 Provider
      </Button>
    </div>

    <!-- Empty state -->
    <div v-if="providers.length === 0" class="flex flex-col items-center justify-center py-20 px-10 text-center">
      <div class="mb-4 w-16 h-16 rounded-full bg-surface border-2 border-dashed border-border flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="w-7 h-7 text-muted">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      </div>
      <div class="text-base font-semibold mb-1.5">尚未配置任何供应商</div>
      <div class="text-[13px] text-muted max-w-[360px] mb-6">添加供应商后，可以配置模型并分配给 Agent 使用。支持 Anthropic、OpenAI、Google、DeepSeek、Ollama 等。</div>
      <Button
        variant="primary"
        @click="editingProvider = null; showModal = true"
      >
        添加第一个供应商
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
        @toggle-model="toggleModel"
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
