<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettings } from '../composables/useSettings'

const props = defineProps<{
  apiKeyMissing?: boolean
}>()

const emit = defineEmits<{
  (e: 'config-applied'): void
}>()

const { config, loading, saving, error, success, load, save, applyLlm } = useSettings()
const activeTab = ref<'api' | 'agent'>('api')
const showKey = ref(false)

onMounted(() => {
  load()
  if (props.apiKeyMissing) {
    activeTab.value = 'api'
  }
})

async function handleSave() {
  if (!config.value) return
  await save()

  // 如果有新输入的 API Key（非脱敏），应用 LLM 配置
  const key = config.value.anthropic_api_key
  if (key && !key.includes('...')) {
    const ok = await applyLlm({
      apiKey: key,
      baseUrl: config.value.anthropic_base_url,
      model: config.value.llm_model,
    })
    if (ok) {
      emit('config-applied')
    }
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <h2 class="mb-6 text-lg font-semibold text-text-primary">Settings</h2>

    <div v-if="loading" class="text-text-tertiary">Loading...</div>
    <div v-else-if="error" class="text-accent-red">{{ error }}</div>

    <div v-else-if="config">
      <!-- API Key 缺失提示 -->
      <div
        v-if="apiKeyMissing && !config.anthropic_api_key"
        class="mb-4 rounded-md border border-accent-red/30 bg-accent-red/10 px-4 py-3"
      >
        <p class="text-sm font-medium text-accent-red">需要配置 API Key 才能开始使用</p>
        <p class="mt-1 text-xs text-accent-red/70">请在下方输入你的 Anthropic API Key</p>
      </div>

      <!-- Tab 切换 -->
      <div class="mb-6 flex gap-0 border-b border-border-default">
        <button
          class="px-4 py-2 text-sm font-medium transition-colors"
          :class="activeTab === 'api'
            ? 'border-b-2 border-accent text-accent'
            : 'text-text-tertiary hover:text-text-primary'"
          @click="activeTab = 'api'"
        >
          API
        </button>
        <button
          class="px-4 py-2 text-sm font-medium transition-colors"
          :class="activeTab === 'agent'
            ? 'border-b-2 border-accent text-accent'
            : 'text-text-tertiary hover:text-text-primary'"
          @click="activeTab = 'agent'"
        >
          Agent
        </button>
      </div>

      <!-- API Tab -->
      <section v-if="activeTab === 'api'" class="space-y-3">
        <div>
          <label class="mb-1 block text-xs text-text-tertiary">API Key</label>
          <div class="flex gap-2">
            <input
              v-model="config.anthropic_api_key"
              :type="showKey ? 'text' : 'password'"
              class="flex-1 rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            />
            <button
              class="rounded-md border border-border-default px-3 text-text-tertiary transition-colors hover:text-text-primary"
              @click="showKey = !showKey"
            >
              {{ showKey ? 'Hide' : 'Show' }}
            </button>
          </div>
        </div>
        <div>
          <label class="mb-1 block text-xs text-text-tertiary">Model</label>
          <input
            v-model="config.llm_model"
            type="text"
            class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
          />
        </div>
        <div>
          <label class="mb-1 block text-xs text-text-tertiary">Base URL</label>
          <input
            v-model="config.anthropic_base_url"
            type="text"
            class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
          />
        </div>
      </section>

      <!-- Agent Tab -->
      <section v-if="activeTab === 'agent'" class="grid grid-cols-2 gap-3">
        <div v-for="field of [
          { key: 'max_turns', label: 'Max Turns', min: 1, max: 200 },
          { key: 'context_window', label: 'Context Window', min: 1000, max: 1000000 },
          { key: 'max_output_tokens', label: 'Max Output Tokens', min: 256, max: 100000 },
          { key: 'tool_output_max_bytes', label: 'Tool Output Max Bytes', min: 1000, max: 1000000 },
          { key: 'bash_default_timeout_secs', label: 'Bash Timeout (sec)', min: 1, max: 600 },
        ]" :key="field.key">
          <label class="mb-1 block text-xs text-text-tertiary">{{ field.label }}</label>
          <input
            v-model.number="config[field.key as keyof typeof config]"
            type="number"
            :min="field.min"
            :max="field.max"
            class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
          />
        </div>
      </section>

      <!-- 保存 -->
      <div class="mt-6 flex items-center gap-3">
        <button
          class="rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg-base transition-colors hover:bg-accent/80"
          :disabled="saving"
          @click="handleSave"
        >
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <span v-if="success" class="text-xs text-accent">Saved.</span>
      </div>
    </div>
  </div>
</template>
