<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ProviderConfig, ModelTier } from '../types'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'

const props = defineProps<{
  editState: { mode: 'add' } | { mode: 'edit'; name: string }
  initialData?: ProviderConfig
}>()

const emit = defineEmits<{
  (e: 'save', config: ProviderConfig): void
  (e: 'cancel'): void
}>()

// 表单状态
const form = ref<ProviderConfig>(
  props.initialData
    ? { ...props.initialData, models: props.initialData.models.map(m => ({ ...m })) }
    : { name: '', api_key: '', base_url: DEFAULT_BASE_URL, models: [] },
)
const showApiKey = ref(false)

// 模型添加输入
const newModelId = ref('')
const newModelAlias = ref('')
const newModelTier = ref<ModelTier>('balanced')

const tiers: { value: ModelTier; label: string }[] = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'fast', label: 'Fast' },
]

function addModel() {
  const id = newModelId.value.trim()
  if (!id) return
  if (form.value.models.some(m => m.id === id)) return
  form.value.models.push({
    id,
    alias: newModelAlias.value.trim() || null,
    tier: newModelTier.value,
  })
  newModelId.value = ''
  newModelAlias.value = ''
  newModelTier.value = 'balanced'
}

function removeModel(index: number) {
  form.value.models.splice(index, 1)
}

function handleSave() {
  emit('save', form.value)
}
</script>

<template>
  <section class="rounded-md border border-semantic-blue/30 bg-elevated p-4 space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium text-muted-foreground">
        {{ editState.mode === 'add' ? 'Add Provider' : `Edit: ${editState.name}` }}
      </h3>
      <Button variant="ghost" size="sm" class="text-xs text-tertiary hover:text-muted-foreground" @click="emit('cancel')">
        Cancel
      </Button>
    </div>

    <!-- Name -->
    <div>
      <label class="mb-1 block text-xs text-tertiary">Name</label>
      <Input
        v-model="form.name"
        type="text"
        :disabled="editState.mode === 'edit'"
        class="font-mono text-sm"
        placeholder="e.g. anthropic"
      />
    </div>

    <!-- API Key -->
    <div>
      <label class="mb-1 block text-xs text-tertiary">API Key</label>
      <div class="flex gap-2">
        <Input
          v-model="form.api_key"
          :type="showApiKey ? 'text' : 'password'"
          class="flex-1 font-mono text-sm"
          placeholder="sk-..."
        />
        <Button
          variant="outline"
          class="px-3 text-xs text-tertiary"
          @click="showApiKey = !showApiKey"
        >
          {{ showApiKey ? 'Hide' : 'Show' }}
        </Button>
      </div>
    </div>

    <!-- Base URL -->
    <div>
      <label class="mb-1 block text-xs text-tertiary">Base URL</label>
      <Input
        v-model="form.base_url"
        type="text"
        class="font-mono text-sm"
        :placeholder="DEFAULT_BASE_URL"
      />
    </div>

    <!-- Models 管理 -->
    <div>
      <label class="mb-2 block text-xs text-tertiary">Models</label>
      <!-- 已有模型列表 -->
      <div v-if="form.models.length > 0" class="mb-3 space-y-1">
        <div
          v-for="(model, i) in form.models"
          :key="model.id"
          class="flex items-center justify-between rounded-sm bg-inset px-3 py-1.5"
        >
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs text-foreground">{{ model.id }}</span>
            <span v-if="model.alias" class="text-xs text-tertiary">({{ model.alias }})</span>
            <Select v-model="form.models[i].tier">
              <SelectTrigger class="h-6 border-border-default bg-surface px-1.5 text-[10px] font-mono text-tertiary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="t in tiers" :key="t.value" :value="t.value" class="text-xs">{{ t.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="link" class="text-xs text-semantic-red" @click="removeModel(i)">Remove</Button>
        </div>
      </div>
      <!-- 添加模型 -->
      <div class="flex items-end gap-2">
        <div class="flex-1">
          <Input
            v-model="newModelId"
            type="text"
            class="font-mono text-xs"
            placeholder="Model ID (e.g. claude-sonnet-4-20250514)"
            @keydown.enter.prevent="addModel"
          />
        </div>
        <div class="w-24">
          <Input
            v-model="newModelAlias"
            type="text"
            class="text-xs"
            placeholder="Alias"
          />
        </div>
        <Select v-model="newModelTier">
          <SelectTrigger class="h-9 border-border-default bg-inset px-2 text-xs text-tertiary">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="t in tiers" :key="t.value" :value="t.value" class="text-xs">{{ t.label }}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" class="px-3 py-2 text-xs" @click="addModel">Add</Button>
      </div>
    </div>

    <!-- 保存/取消 -->
    <div class="flex justify-end gap-2">
      <Button variant="outline" class="px-4 py-2 text-xs" @click="emit('cancel')">Cancel</Button>
      <Button class="px-4 py-2 text-xs font-mono text-bg-base bg-semantic-green hover:bg-semantic-green/90" @click="handleSave">
        Save Provider
      </Button>
    </div>
  </section>
</template>
