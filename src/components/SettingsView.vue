<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useSettings } from '../composables/useSettings'
import ProviderManager from './ProviderManager.vue'
import PromptsTab from './PromptsTab.vue'
import AgentTab from './AgentTab.vue'
import ToolsTab from './ToolsTab.vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  apiKeyMissing?: boolean
}>()

const emit = defineEmits<{
  (e: 'config-applied'): void
}>()

const { config, loading: configLoading, saving, error: configError, success, load: loadConfig, save: saveConfig } = useSettings()

const activeTab = ref<'llm' | 'agent' | 'prompts' | 'tools'>('llm')

async function handleSave() {
  await saveConfig()
  emit('config-applied')
}

async function reloadConfig() {
  await loadConfig()
}

onMounted(async () => {
  loadConfig()
  if (props.apiKeyMissing) {
    activeTab.value = 'llm'
  }
})
</script>

<template>
  <div class="flex h-full flex-1 flex-col overflow-y-auto px-8 py-6">
    <h2 class="mb-6 text-lg font-semibold text-foreground">Settings</h2>

    <!-- Tab 切换 -->
    <div class="mb-6 flex border-b border-border-default">
      <Button
        variant="ghost"
        size="sm"
        class="px-4 pb-2 text-sm font-medium"
        :class="activeTab === 'llm'
          ? 'border-b-2 border-semantic-green text-foreground'
          : 'text-tertiary hover:text-muted-foreground'"
        @click="activeTab = 'llm'"
      >
        LLM
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class="px-4 pb-2 text-sm font-medium"
        :class="activeTab === 'agent'
          ? 'border-b-2 border-semantic-green text-foreground'
          : 'text-tertiary hover:text-muted-foreground'"
        @click="activeTab = 'agent'"
      >
        Agent
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class="px-4 pb-2 text-sm font-medium"
        :class="activeTab === 'prompts'
          ? 'border-b-2 border-semantic-green text-foreground'
          : 'text-tertiary hover:text-muted-foreground'"
        @click="activeTab = 'prompts'"
      >
        Prompts
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class="px-4 pb-2 text-sm font-medium"
        :class="activeTab === 'tools'
          ? 'border-b-2 border-semantic-green text-foreground'
          : 'text-tertiary hover:text-muted-foreground'"
        @click="activeTab = 'tools'"
      >
        Tools
      </Button>
    </div>

    <!-- Tab: LLM -->
    <div v-if="activeTab === 'llm'">
      <div v-if="configLoading" class="text-tertiary">Loading...</div>
      <div v-else-if="configError" class="text-semantic-red">{{ configError }}</div>

      <div v-else-if="config" class="space-y-8">
        <!-- API Key 缺失提示 -->
        <div
          v-if="apiKeyMissing && config.providers.length === 0"
          class="rounded-md border border-semantic-red/30 bg-semantic-red/10 px-4 py-3"
        >
          <p class="text-sm font-medium text-semantic-red">需要配置 API Key 才能开始使用</p>
          <p class="mt-1 text-xs text-semantic-red/70">请在下方添加一个 Provider 并配置 API Key</p>
        </div>

        <!-- Provider 管理 -->
        <ProviderManager :config="config" @config-reloaded="reloadConfig" />

        <!-- Thinking Mode -->
        <section class="rounded-lg border border-border-default bg-inset p-4">
          <h3 class="mb-3 text-sm font-medium text-muted-foreground">Thinking Mode</h3>
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              v-model="config.thinking_enabled"
              class="h-4 w-4 rounded border-border-default bg-inset"
            />
            <span class="text-sm text-muted-foreground">Extended Thinking</span>
          </div>
          <div v-if="config.thinking_enabled" class="mt-3">
            <label class="mb-1 block text-xs text-tertiary">Budget Tokens</label>
            <input
              type="range"
              v-model.number="config.thinking_budget_tokens"
              min="1000"
              max="128000"
              step="1000"
              class="w-full"
            />
            <span class="text-xs text-tertiary">
              {{ config.thinking_budget_tokens?.toLocaleString() }} tokens
            </span>
            <p class="mt-1 text-xs text-tertiary">
              Controls model thinking depth. Higher = deeper thinking, slower responses, more token usage.
            </p>
          </div>
        </section>

        <!-- 保存 -->
        <div class="flex items-center gap-3">
          <Button
            class="font-mono text-sm"
            :disabled="saving"
            @click="handleSave"
          >
            {{ saving ? 'Saving...' : 'Save' }}
          </Button>
          <span v-if="success" class="text-xs text-semantic-green">Saved.</span>
        </div>
      </div>
    </div>

    <!-- Tab: Agent -->
    <div v-if="activeTab === 'agent'">
      <div v-if="configLoading" class="text-tertiary">Loading...</div>
      <div v-else-if="configError" class="text-semantic-red">{{ configError }}</div>
      <AgentTab
        v-else
        :config="config"
        :saving="saving"
        :success="success"
        @save="handleSave"
      />
    </div>

    <!-- Tab: Prompts -->
    <div v-if="activeTab === 'prompts'">
      <PromptsTab />
    </div>

    <!-- Tab: Tools -->
    <div v-if="activeTab === 'tools'">
      <ToolsTab />
    </div>
  </div>
</template>
