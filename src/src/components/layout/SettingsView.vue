<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { useProvider } from '../../composables/useProvider'
import { useModel } from '../../composables/useModel'
import { ProviderList, ProviderForm } from '../settings'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const { providers, loadProviders, setProvider, deleteProvider } = useProvider()
const { models, loadModels } = useModel()

const activeTab = ref('providers')
const editingProviderId = ref<string | null>(null)
const showForm = ref(false)
const loading = ref(false)

const tabs = computed(() => [
  { label: t('settings.tabProviders'), value: 'providers' },
  { label: t('settings.tabSkills'), value: 'skills' },
  { label: t('settings.tabAgents'), value: 'agents' },
])

const editingProvider = computed(() =>
  editingProviderId.value
    ? providers.value.find(p => p.id === editingProviderId.value) ?? null
    : null,
)

const providerModels = computed(() =>
  models.value.filter(m =>
    editingProviderId.value ? m.providerId === editingProviderId.value : true,
  ),
)

function close() {
  settingsStore.setView('chat')
}

function handleEdit(providerId: string) {
  editingProviderId.value = providerId
  showForm.value = true
}

function handleAdd() {
  editingProviderId.value = null
  showForm.value = true
}

function handleDelete(providerId: string) {
  deleteProvider(providerId)
  showForm.value = false
  editingProviderId.value = null
}

function handleSave(payload: { providerId: string; apiKey: string; baseUrl?: string }) {
  setProvider(payload.providerId, payload.apiKey, payload.baseUrl)
  showForm.value = false
  editingProviderId.value = null
}

function handleCancel() {
  showForm.value = false
  editingProviderId.value = null
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    close()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    close()
  }
}

const DEBOUNCE_MS = 500

onMounted(() => {
  loading.value = true
  loadProviders()
  loadModels()
  // Brief loading state — real loading would be driven by WS response
  setTimeout(() => { loading.value = false }, DEBOUNCE_MS)
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="settings-view">
    <!-- Header -->
    <div class="settings-view__header">
      <h2 class="settings-view__title">{{ t('settings.title') }}</h2>
      <button
        class="settings-view__close"
        :aria-label="t('common.close')"
        @click="close"
      >
        ✕
      </button>
    </div>

    <!-- Body -->
    <div class="settings-view__body">
      <!-- Tab nav -->
      <nav class="settings-view__tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          :class="['settings-view__tab', { 'settings-view__tab--active': activeTab === tab.value }]"
          role="tab"
          :aria-selected="activeTab === tab.value"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </nav>

      <!-- Content -->
      <div class="settings-view__content">
        <!-- Providers tab -->
        <template v-if="activeTab === 'providers'">
          <ProviderForm
            v-if="showForm"
            :provider="editingProvider"
            :models="providerModels"
            :is-edit="!!editingProviderId"
            @save="handleSave"
            @cancel="handleCancel"
            @delete="handleDelete"
          />
          <ProviderList
            v-else
            :providers="providers"
            :loading="loading"
            @edit="handleEdit"
            @delete="handleDelete"
            @add="handleAdd"
          />
        </template>

        <!-- Skills placeholder -->
        <div v-else-if="activeTab === 'skills'" class="settings-view__placeholder">
          <p>{{ t('settings.skillsPlaceholder') }}</p>
        </div>

        <!-- Agents placeholder -->
        <div v-else-if="activeTab === 'agents'" class="settings-view__placeholder">
          <p>{{ t('settings.agentsPlaceholder') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-base);
}

.settings-view__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--radius-lg, 12px) var(--radius-xl, 16px);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.settings-view__title {
  font-size: var(--font-lg, 1.125rem);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
}

.settings-view__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md, 8px);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-md, 1rem);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.settings-view__close:hover {
  background: var(--color-surface);
  color: var(--color-text-primary);
}

.settings-view__body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Tab nav — vertical on left */
.settings-view__tabs {
  display: flex;
  flex-direction: column;
  gap: var(--radius-xs, 4px);
  padding: var(--radius-lg, 12px);
  border-right: 1px solid var(--color-border);
  min-width: 140px;
  flex-shrink: 0;
}

.settings-view__tab {
  display: flex;
  align-items: center;
  padding: var(--radius-sm, 4px) var(--radius-md, 8px);
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-sm, 0.875rem);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.settings-view__tab:hover {
  background: var(--color-surface);
  color: var(--color-text-primary);
}

.settings-view__tab--active {
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-weight: 500;
}

/* Content area */
.settings-view__content {
  flex: 1;
  padding: var(--radius-xl, 16px);
  overflow-y: auto;
}

.settings-view__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: var(--font-sm, 0.875rem);
}
</style>
