<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettings } from '../composables/useSettings'

const { config, loading, saving, error, success, load, save } = useSettings()

onMounted(() => { load() })
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <h2 class="mb-6 text-lg font-semibold text-text-primary">Settings</h2>

    <div v-if="loading" class="text-text-tertiary">Loading...</div>
    <div v-else-if="error" class="text-accent-red">{{ error }}</div>

    <div v-else-if="config" class="space-y-8">
      <!-- LLM 配置 -->
      <section>
        <h3 class="mb-3 text-sm font-medium text-text-secondary">LLM Configuration</h3>
        <div class="space-y-3">
          <div>
            <label class="mb-1 block text-xs text-text-tertiary">API Key</label>
            <input
              v-model="config.anthropic_api_key"
              type="password"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            />
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
        </div>
      </section>

      <!-- Agent 配置 -->
      <section>
        <h3 class="mb-3 text-sm font-medium text-text-secondary">Agent Configuration</h3>
        <div class="grid grid-cols-2 gap-3">
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
        </div>
      </section>

      <!-- 保存 -->
      <div class="flex items-center gap-3">
        <button
          class="rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg-base transition-colors hover:bg-accent/80"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <span v-if="success" class="text-xs text-accent">Saved. Restart to apply changes.</span>
      </div>
    </div>
  </div>
</template>
