<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useProvider } from '../../composables/useProvider'
import { useModel } from '../../composables/useModel'
import { ProviderList, ProviderForm, SkillsTab, AgentsTab } from '../settings'

const settingsStore = useSettingsStore()
const { providers, loadProviders, setProvider, deleteProvider } = useProvider()
const { models, loadModels } = useModel()

const activeTab = ref('providers')
const editingProviderId = ref<string | null>(null)
const showForm = ref(false)
const loading = ref(false)

// TODO: wire to real skill/agent data from store
const skills = ref<Array<{ name: string; description: string; enabled: boolean }>>([])
const agents = ref<Array<{ name: string; model: string; active: boolean }>>([])
const agentConfig = ref<Array<{ label: string; value: string }>>([])

function handleSkillToggle(name: string) {
  const skill = skills.value.find(s => s.name === name)
  if (skill) skill.enabled = !skill.enabled
}

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
    settingsStore.setView('chat')
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    settingsStore.setView('chat')
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
  <div class="settings-view active">
    <!-- Sidebar -->
    <div class="settings-sidebar">
      <div class="settings-sidebar__hd">设置</div>
      <div class="settings-sidebar__list">
        <div
          class="settings-tab"
          :class="{ active: activeTab === 'providers' }"
          @click="activeTab = 'providers'"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 8h4M5 10h5"/></svg>
          供应商
        </div>
        <div
          class="settings-tab"
          :class="{ active: activeTab === 'skills' }"
          @click="activeTab = 'skills'"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z"/></svg>
          SKILL
        </div>
        <div
          class="settings-tab"
          :class="{ active: activeTab === 'agents' }"
          @click="activeTab = 'agents'"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
          AGENT
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="settings-content">
      <!-- Providers pane -->
      <div class="settings-content__pane" :class="{ active: activeTab === 'providers' }">
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
      </div>

      <!-- Skills pane -->
      <div class="settings-content__pane" :class="{ active: activeTab === 'skills' }">
        <SkillsTab
          :skills="skills"
          @toggle="handleSkillToggle"
        />
      </div>

      <!-- Agents pane -->
      <div class="settings-content__pane" :class="{ active: activeTab === 'agents' }">
        <AgentsTab
          :agents="agents"
          :config-rows="agentConfig"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* All styles come from the global design system — no scoped overrides needed */
</style>
