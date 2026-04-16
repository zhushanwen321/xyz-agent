<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { useModelManager } from '../composables/useModelManager'
import type { ConfigResponse, ProviderConfig } from '../types'
import ProviderEditForm from './ProviderEditForm.vue'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'

const props = defineProps<{
  config: ConfigResponse
}>()

const emit = defineEmits<{
  (e: 'config-reloaded'): void
}>()

const { setCurrentModel, saveProvider, deleteProviderConfig } = useModelManager()

// 编辑状态：null 表示未编辑
type EditState = { mode: 'add' } | { mode: 'edit'; name: string } | null
const editState = ref<EditState>(null)
const editInitialData = ref<ProviderConfig | undefined>(undefined)
const saving = ref(false)
const error = ref<string | null>(null)

// 内联删除确认状态
const pendingDelete = ref<string | null>(null)

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '...'
}

function openAdd() {
  editState.value = { mode: 'add' }
  editInitialData.value = undefined
  error.value = null
}

function openEdit(provider: ProviderConfig) {
  editState.value = { mode: 'edit', name: provider.name }
  editInitialData.value = {
    name: provider.name,
    api_key: provider.api_key,
    base_url: provider.base_url,
    models: provider.models.map(m => ({ ...m })),
  }
  error.value = null
}

function cancelEdit() {
  editState.value = null
  editInitialData.value = undefined
  error.value = null
}

async function handleSaveProvider(config: ProviderConfig) {
  if (!config.name.trim()) {
    error.value = 'Provider name is required'
    return
  }
  saving.value = true
  error.value = null
  try {
    await saveProvider(config)
    cancelEdit()
    emit('config-reloaded')
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

function requestDelete(name: string) {
  pendingDelete.value = name
}

function cancelDelete() {
  pendingDelete.value = null
}

async function confirmDeleteProvider(name: string) {
  saving.value = true
  error.value = null
  try {
    await deleteProviderConfig(name)
    pendingDelete.value = null
    emit('config-reloaded')
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

async function handleSetDefault(modelRef: string) {
  try {
    await setCurrentModel(modelRef)
    emit('config-reloaded')
  } catch (e) {
    error.value = String(e)
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- 错误提示 -->
    <div v-if="error" class="rounded-md border border-semantic-red/30 bg-semantic-red/10 px-4 py-3">
      <p class="text-sm text-semantic-red">{{ error }}</p>
    </div>

    <!-- Provider 列表 -->
    <section>
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-sm font-medium text-muted-foreground">Providers</h3>
        <Button variant="link" class="text-xs text-semantic-blue" @click="openAdd">
          + Add Provider
        </Button>
      </div>

      <div v-if="config.providers.length === 0" class="text-xs text-tertiary">
        No providers configured. Add one to get started.
      </div>

      <div class="space-y-3">
        <div
          v-for="provider in config.providers"
          :key="provider.name"
          class="rounded-md border border-border-default bg-elevated p-4"
        >
          <div class="flex items-start justify-between">
            <div>
              <span class="font-mono text-sm font-medium text-foreground">{{ provider.name }}</span>
              <div class="mt-1 space-y-0.5">
                <p class="text-xs text-tertiary">
                  Key: <span class="font-mono">{{ maskKey(provider.api_key) }}</span>
                </p>
                <p v-if="provider.base_url && provider.base_url !== DEFAULT_BASE_URL" class="text-xs text-tertiary">
                  URL: <span class="font-mono">{{ provider.base_url }}</span>
                </p>
              </div>
            </div>
            <!-- 操作按钮 / 删除确认 -->
            <div v-if="pendingDelete === provider.name" class="flex items-center gap-2">
              <span class="text-xs text-semantic-red">Delete?</span>
              <Button variant="link" class="text-xs text-semantic-red" @click="confirmDeleteProvider(provider.name)">
                Confirm
              </Button>
              <Button variant="ghost" size="sm" class="text-xs" @click="cancelDelete">Cancel</Button>
            </div>
            <div v-else class="flex gap-2">
              <Button variant="link" class="text-xs text-semantic-blue" @click="openEdit(provider)">
                Edit
              </Button>
              <Button variant="link" class="text-xs text-semantic-red" @click="requestDelete(provider.name)">
                Delete
              </Button>
            </div>
          </div>

          <!-- 模型列表 -->
          <div v-if="provider.models.length > 0" class="mt-3 border-t border-border-default pt-3">
            <p class="mb-2 text-xs font-medium text-tertiary">Models</p>
            <div class="space-y-1">
              <div
                v-for="model in provider.models"
                :key="model.id"
                class="flex items-center justify-between rounded-sm bg-inset px-3 py-1.5"
              >
                <div class="flex items-center gap-2">
                  <span class="font-mono text-xs text-foreground">{{ model.id }}</span>
                  <span v-if="model.alias" class="text-xs text-tertiary">({{ model.alias }})</span>
                  <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] font-mono text-tertiary">
                    {{ model.tier }}
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <Button
                    v-if="config.current_model !== `${provider.name}/${model.id}`"
                    variant="link"
                    class="text-[10px] text-semantic-blue"
                    @click="handleSetDefault(`${provider.name}/${model.id}`)"
                  >
                    Set Default
                  </Button>
                  <span v-else class="text-[10px] font-mono text-semantic-green">default</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 当前模型 -->
    <section v-if="config.current_model" class="rounded-md border border-border-default bg-inset p-3">
      <div class="flex items-center gap-2">
        <span class="text-xs text-tertiary">Current Model:</span>
        <span class="font-mono text-sm text-foreground">{{ config.current_model }}</span>
      </div>
    </section>

    <!-- Provider 编辑表单 -->
    <ProviderEditForm
      v-if="editState"
      :edit-state="editState"
      :initial-data="editInitialData"
      @save="handleSaveProvider"
      @cancel="cancelEdit"
    />
  </div>
</template>
