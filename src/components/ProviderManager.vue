<script setup lang="ts">
import { ref } from 'vue'
import { useModelManager } from '../composables/useModelManager'
import type { ConfigResponse, ProviderConfig, ModelTier } from '../types'

const props = defineProps<{
  config: ConfigResponse
}>()

const emit = defineEmits<{
  (e: 'config-reloaded'): void
}>()

const { setCurrentModel, saveProvider, deleteProviderConfig } = useModelManager()

// Provider 编辑状态
type EditState = { mode: 'add' } | { mode: 'edit'; name: string } | null
const editState = ref<EditState>(null)
const editForm = ref<ProviderConfig>({ name: '', api_key: '', base_url: 'https://api.anthropic.com', models: [] })
const showApiKey = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

// 模型编辑状态（嵌套在 Provider 编辑内）
const newModelId = ref('')
const newModelAlias = ref('')
const newModelTier = ref<ModelTier>('balanced')

// 所有 tier 选项
const tiers: { value: ModelTier; label: string }[] = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'fast', label: 'Fast' },
]

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 8) + '...'
}

function openAdd() {
  editState.value = { mode: 'add' }
  editForm.value = { name: '', api_key: '', base_url: 'https://api.anthropic.com', models: [] }
  showApiKey.value = false
  error.value = null
}

function openEdit(provider: ProviderConfig) {
  editState.value = { mode: 'edit', name: provider.name }
  // 深拷贝以避免直接修改 props
  editForm.value = {
    name: provider.name,
    api_key: provider.api_key,
    base_url: provider.base_url,
    models: provider.models.map(m => ({ ...m })),
  }
  showApiKey.value = false
  error.value = null
}

function cancelEdit() {
  editState.value = null
  editForm.value = { name: '', api_key: '', base_url: 'https://api.anthropic.com', models: [] }
  error.value = null
}

async function handleSaveProvider() {
  if (!editForm.value.name.trim()) {
    error.value = 'Provider name is required'
    return
  }
  saving.value = true
  error.value = null
  try {
    await saveProvider(editForm.value)  // saveProvider 内部已调用 load() 刷新列表
    cancelEdit()
    emit('config-reloaded')
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

async function handleDeleteProvider(name: string) {
  if (!confirm(`Delete provider "${name}" and all its models?`)) return
  saving.value = true
  error.value = null
  try {
    await deleteProviderConfig(name)  // deleteProviderConfig 内部已调用 load() 刷新列表
    emit('config-reloaded')
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

// 模型 CRUD（在编辑表单内操作 editForm.models）
function addModel() {
  const id = newModelId.value.trim()
  if (!id) return
  if (editForm.value.models.some(m => m.id === id)) return
  editForm.value.models.push({
    id,
    alias: newModelAlias.value.trim() || null,
    tier: newModelTier.value,
  })
  newModelId.value = ''
  newModelAlias.value = ''
  newModelTier.value = 'balanced'
}

function removeModel(index: number) {
  editForm.value.models.splice(index, 1)
}

// 默认模型切换
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
    <div v-if="error" class="rounded-md border border-accent-red/30 bg-accent-red/10 px-4 py-3">
      <p class="text-sm text-accent-red">{{ error }}</p>
    </div>

    <!-- Provider 列表 -->
    <section>
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-sm font-medium text-text-secondary">Providers</h3>
        <button
          class="text-xs text-accent-blue hover:underline"
          @click="openAdd"
        >
          + Add Provider
        </button>
      </div>

      <!-- 无 Provider 提示 -->
      <div v-if="config.providers.length === 0" class="text-xs text-text-tertiary">
        No providers configured. Add one to get started.
      </div>

      <!-- Provider 卡片列表 -->
      <div class="space-y-3">
        <div
          v-for="provider in config.providers"
          :key="provider.name"
          class="rounded-md border border-border-default bg-bg-elevated p-4"
        >
          <div class="flex items-start justify-between">
            <div>
              <span class="font-mono text-sm font-medium text-text-primary">{{ provider.name }}</span>
              <div class="mt-1 space-y-0.5">
                <p class="text-xs text-text-tertiary">
                  Key: <span class="font-mono">{{ maskKey(provider.api_key) }}</span>
                </p>
                <p v-if="provider.base_url" class="text-xs text-text-tertiary">
                  URL: <span class="font-mono">{{ provider.base_url }}</span>
                </p>
              </div>
            </div>
            <div class="flex gap-2">
              <button
                class="text-xs text-accent-blue hover:underline"
                @click="openEdit(provider)"
              >Edit</button>
              <button
                class="text-xs text-accent-red hover:underline"
                @click="handleDeleteProvider(provider.name)"
              >Delete</button>
            </div>
          </div>

          <!-- Provider 下的模型列表 -->
          <div v-if="provider.models.length > 0" class="mt-3 border-t border-border-default pt-3">
            <p class="mb-2 text-xs font-medium text-text-tertiary">Models</p>
            <div class="space-y-1">
              <div
                v-for="model in provider.models"
                :key="model.id"
                class="flex items-center justify-between rounded-sm bg-bg-inset px-3 py-1.5"
              >
                <div class="flex items-center gap-2">
                  <span class="font-mono text-xs text-text-primary">{{ model.id }}</span>
                  <span v-if="model.alias" class="text-xs text-text-tertiary">({{ model.alias }})</span>
                  <span class="rounded-sm bg-bg-surface px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary">
                    {{ model.tier }}
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    v-if="config.current_model !== `${provider.name}/${model.id}`"
                    class="text-[10px] text-accent-blue hover:underline"
                    @click="handleSetDefault(`${provider.name}/${model.id}`)"
                  >Set Default</button>
                  <span v-else class="text-[10px] font-mono text-accent">default</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 当前模型显示 -->
    <section v-if="config.current_model" class="rounded-md border border-border-default bg-bg-inset p-3">
      <div class="flex items-center gap-2">
        <span class="text-xs text-text-tertiary">Current Model:</span>
        <span class="font-mono text-sm text-text-primary">{{ config.current_model }}</span>
      </div>
    </section>

    <!-- Provider 添加/编辑表单（模态或内联） -->
    <section v-if="editState" class="rounded-md border border-accent-blue/30 bg-bg-elevated p-4 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium text-text-secondary">
          {{ editState.mode === 'add' ? 'Add Provider' : `Edit: ${editState.name}` }}
        </h3>
        <button class="text-xs text-text-tertiary hover:text-text-secondary" @click="cancelEdit">Cancel</button>
      </div>

      <!-- Name -->
      <div>
        <label class="mb-1 block text-xs text-text-tertiary">Name</label>
        <input
          v-model="editForm.name"
          type="text"
          :disabled="editState.mode === 'edit'"
          class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary disabled:opacity-50"
          placeholder="e.g. anthropic"
        />
      </div>

      <!-- API Key -->
      <div>
        <label class="mb-1 block text-xs text-text-tertiary">API Key</label>
        <div class="flex gap-2">
          <input
            v-model="editForm.api_key"
            :type="showApiKey ? 'text' : 'password'"
            class="flex-1 rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            placeholder="sk-..."
          />
          <button
            class="rounded-md border border-border-default px-3 text-text-tertiary transition-colors hover:text-text-primary"
            @click="showApiKey = !showApiKey"
          >
            {{ showApiKey ? 'Hide' : 'Show' }}
          </button>
        </div>
      </div>

      <!-- Base URL -->
      <div>
        <label class="mb-1 block text-xs text-text-tertiary">Base URL</label>
        <input
          v-model="editForm.base_url"
          type="text"
          class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
          placeholder="https://api.anthropic.com"
        />
      </div>

      <!-- Models 管理 -->
      <div>
        <label class="mb-2 block text-xs text-text-tertiary">Models</label>
        <!-- 已有模型列表 -->
        <div v-if="editForm.models.length > 0" class="mb-3 space-y-1">
          <div
            v-for="(model, i) in editForm.models"
            :key="model.id"
            class="flex items-center justify-between rounded-sm bg-bg-inset px-3 py-1.5"
          >
            <div class="flex items-center gap-2">
              <span class="font-mono text-xs text-text-primary">{{ model.id }}</span>
              <span v-if="model.alias" class="text-xs text-text-tertiary">({{ model.alias }})</span>
              <select
                v-model="editForm.models[i].tier"
                class="rounded-sm border border-border-default bg-bg-surface px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary"
              >
                <option v-for="t in tiers" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </div>
            <button class="text-xs text-accent-red hover:underline" @click="removeModel(i)">Remove</button>
          </div>
        </div>
        <!-- 添加模型 -->
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <input
              v-model="newModelId"
              type="text"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-xs text-text-primary"
              placeholder="Model ID (e.g. claude-sonnet-4-20250514)"
              @keydown.enter.prevent="addModel"
            />
          </div>
          <div class="w-24">
            <input
              v-model="newModelAlias"
              type="text"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 text-xs text-text-primary"
              placeholder="Alias"
            />
          </div>
          <select
            v-model="newModelTier"
            class="rounded-md border border-border-default bg-bg-inset px-2 py-2 text-xs text-text-tertiary"
          >
            <option v-for="t in tiers" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
          <button
            class="rounded-md border border-border-default px-3 py-2 text-xs text-text-secondary hover:text-text-primary"
            @click="addModel"
          >Add</button>
        </div>
      </div>

      <!-- 保存/取消 -->
      <div class="flex justify-end gap-2">
        <button
          class="rounded-md border border-border-default px-4 py-2 text-xs text-text-secondary"
          @click="cancelEdit"
        >Cancel</button>
        <button
          class="rounded-md bg-accent px-4 py-2 font-mono text-xs text-bg-base"
          :disabled="saving"
          @click="handleSaveProvider"
        >
          {{ saving ? 'Saving...' : 'Save Provider' }}
        </button>
      </div>
    </section>
  </div>
</template>
