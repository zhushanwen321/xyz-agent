<script setup lang="ts">
import { ref, computed } from 'vue'
import { Button } from '../../design-system'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'
import { useProviderStore } from '../../stores/provider'
import { send } from '../../lib/ws-client'
import ProviderCard from './ProviderCard.vue'
import ProviderModal from './ProviderModal.vue'

// ─── Store ──────────────────────────────────────────────────────

const providerStore = useProviderStore()

// ─── State ──────────────────────────────────────────────────────

const providers = computed(() => providerStore.providers)
const models = computed(() => providerStore.models)
const expandedId = ref<string | null>(null)
const showModal = ref(false)
const editingProvider = ref<ProviderInfo | null>(null)

// ─── Computed ───────────────────────────────────────────────────

const modalTitle = computed(() =>
  editingProvider.value ? '编辑供应商' : '添加供应商',
)

const editingModels = computed<ModelInfo[]>(() => {
  if (!editingProvider.value) return []
  return models.value.filter(m => m.providerId === editingProvider.value!.id)
})

// ─── Helpers ────────────────────────────────────────────────────

function getModelsFor(providerId: string): ModelInfo[] {
  return models.value.filter(m => m.providerId === providerId)
}

// ─── Actions ────────────────────────────────────────────────────

function openEdit(id: string) {
  const p = providers.value.find(p => p.id === id)
  if (p) {
    editingProvider.value = p
    showModal.value = true
  }
}

function handleDelete(id: string) {
  send({ type: 'config.deleteProvider', payload: { providerId: id } })
  if (expandedId.value === id) expandedId.value = null
}

function handleTest(_id: string) {
  void _id // P1: no-op
}

function toggleProvider(id: string) {
  const p = providers.value.find(p => p.id === id)
  if (p) {
    const newStatus = p.status === 'connected' ? 'not_configured' : 'connected'
    send({ type: 'config.setProvider', payload: { providerId: id, status: newStatus } })
  }
}

function toggleModel(providerId: string, modelId: string) {
  const m = models.value.find(m => m.id === modelId && m.providerId === providerId)
  if (m) {
    send({ type: 'model.switch', payload: { modelId, enabled: !m.enabled } })
  }
}

function handleModalTest(_data: { url: string; key: string }) {
  void _data // P1: no-op
}

function handleSave(_data: {
  name: string
  type: string
  url: string
  key: string
  models: { id: string; name: string; ctx: string; tags: string[] }[]
}) {
  send({ type: 'config.setProvider', payload: { ..._data } })
  showModal.value = false
  editingProvider.value = null
}
</script>

<template>
  <div class="provider-pane">
    <div class="page__hd">
      <div class="page__title">供应商配置</div>
      <Button
        variant="primary"
        @click="editingProvider = null; showModal = true"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        添加供应商
      </Button>
    </div>

    <!-- Empty state -->
    <div v-if="providers.length === 0" class="empty-state">
      <div class="empty-state__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      </div>
      <div class="empty-state__title">尚未配置任何供应商</div>
      <div class="empty-state__desc">添加供应商后，可以配置模型并分配给 Agent 使用。支持 Anthropic、OpenAI、Google、DeepSeek、Ollama 等。</div>
      <Button
        variant="primary"
        @click="editingProvider = null; showModal = true"
      >
        添加第一个供应商
      </Button>
    </div>

    <!-- Provider list -->
    <template v-else>
      <ProviderCard
        v-for="provider in providers"
        :key="provider.id"
        :provider="provider"
        :models="getModelsFor(provider.id)"
        :expanded="expandedId === provider.id"
        @toggle="expandedId = expandedId === provider.id ? null : provider.id"
        @edit="openEdit"
        @delete="handleDelete"
        @test="handleTest"
        @toggle-enabled="toggleProvider"
        @toggle-model="toggleModel"
      />
    </template>

    <ProviderModal
      :visible="showModal"
      :title="modalTitle"
      :provider="editingProvider"
      :models="editingModels"
      @close="showModal = false"
      @save="handleSave"
      @test="handleModalTest"
    />
  </div>
</template>

<style scoped>
.provider-pane {
  max-width: 860px;
  padding: 32px 40px;
}

.page__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}

.page__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 40px;
  text-align: center;
}

.empty-state__icon {
  font-size: 40px;
  color: var(--border);
  margin-bottom: 16px;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px dashed var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-state__icon svg {
  width: 28px;
  height: 28px;
  stroke: var(--muted);
}

.empty-state__title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}

.empty-state__desc {
  font-size: 13px;
  color: var(--muted);
  max-width: 360px;
  margin-bottom: 24px;
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
</style>
