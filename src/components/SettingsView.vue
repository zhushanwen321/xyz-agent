<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useSettings } from '../composables/useSettings'
import { usePromptManager } from '../composables/usePromptManager'
import type { PromptInfo, PromptSaveInput, CustomAgentInput } from '../types'

const { config, loading: configLoading, saving, error: configError, success, load: loadConfig, save: saveConfig } = useSettings()
const {
  prompts,
  loading: promptsLoading,
  error: promptsError,
  load: loadPrompts,
  save: savePrompt,
  remove: deletePrompt,
  preview: previewPrompt,
  saveAgent,
  deleteAgent,
} = usePromptManager()

const activeTab = ref<'llm' | 'agent' | 'prompts'>('llm')

// 提示词编辑状态
const editingPrompt = ref<PromptInfo | null>(null)
const editMode = ref<'enhance' | 'override'>('enhance')
const editContent = ref('')
const previewContent = ref<string | null>(null)

// Prompts Tab 编辑面板状态
type EditTarget =
  | { type: 'builtin'; key: string }
  | { type: 'custom'; key: string }
  | { type: 'new-agent' }
  | null
const editTarget = ref<EditTarget>(null)
const editPanelTab = ref<'edit' | 'preview'>('edit')

// 自定义 Agent 编辑状态
const showAgentDialog = ref(false)
const agentForm = ref<CustomAgentInput>({
  name: '', content: '', tools: [],
  description: '', read_only: false,
  max_tokens: 100_000, max_turns: 30, max_tool_calls: 100,
})
const agentToolInput = ref('')
const restartHint = ref(false)
let unlistenFn: UnlistenFn | null = null

// 内置 prompt 和自定义 prompt 分组
const builtinPrompts = computed(() => prompts.value.filter(p => p.mode !== 'custom'))
const customPrompts = computed(() => prompts.value.filter(p => p.mode === 'custom'))

// prompt 的简短描述（截取前 80 字符）
function promptDescription(prompt: PromptInfo): string {
  const text = prompt.content.trim()
  const firstLine = text.split('\n').find(l => l.trim().length > 0) || ''
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
}

// mode 标签颜色
function modeColor(mode: string): string {
  switch (mode) {
    case 'enhance': return 'text-accent-blue'
    case 'override': return 'text-accent-yellow'
    case 'custom': return 'text-accent'
    default: return 'text-text-tertiary'
  }
}

function openEdit(prompt: PromptInfo) {
  editingPrompt.value = prompt
  editMode.value = prompt.has_override ? 'override' : 'enhance'
  editContent.value = ''
  previewContent.value = null
}

function closeEdit() {
  editingPrompt.value = null
  editContent.value = ''
  previewContent.value = null
}

async function handleSavePrompt() {
  if (!editingPrompt.value) return
  const input: PromptSaveInput = {
    key: editingPrompt.value.key,
    mode: editMode.value,
    content: editContent.value,
  }
  try {
    await savePrompt(input)
    closeEdit()
  } catch (e) {
    alert(String(e))
  }
}

async function handleDeletePrompt(key: string) {
  try {
    await deletePrompt(key)
  } catch (e) {
    alert(String(e))
  }
}

async function handlePreview(key: string) {
  try {
    previewContent.value = await previewPrompt(key)
  } catch (e) {
    previewContent.value = String(e)
  }
}

function openAgentDialog() {
  agentForm.value = {
    name: '',
    content: '',
    tools: [],
    description: '',
    read_only: false,
    max_tokens: 100_000,
    max_turns: 30,
    max_tool_calls: 100,
  }
  agentToolInput.value = ''
  showAgentDialog.value = true
}

function addTool() {
  const tool = agentToolInput.value.trim()
  if (tool && !agentForm.value.tools.includes(tool)) {
    agentForm.value.tools.push(tool)
    agentToolInput.value = ''
  }
}

function removeTool(index: number) {
  agentForm.value.tools.splice(index, 1)
}

async function handleSaveAgent() {
  try {
    await saveAgent(agentForm.value)
    showAgentDialog.value = false
    restartHint.value = true
  } catch (e) {
    alert(String(e))
  }
}

async function handleDeleteAgent(name: string) {
  try {
    await deleteAgent(name)
  } catch (e) {
    alert(String(e))
  }
}

onMounted(async () => {
  loadConfig()
  loadPrompts()
  unlistenFn = await listen<{ message: string }>('config:thinking-changed', () => {
    restartHint.value = true
  })
})

onUnmounted(() => { unlistenFn?.() })

// 暂存引用，后续 Task 启用右侧编辑面板后清理
void [editPanelTab, handleSavePrompt, openAgentDialog, addTool, removeTool, handleSaveAgent]
</script>

<template>
  <div class="flex h-full flex-col px-8 py-6">
    <h2 class="mb-6 text-lg font-semibold text-text-primary">Settings</h2>

    <!-- Tab 切换 -->
    <div class="mb-6 flex border-b border-border-default">
      <button
        class="px-4 pb-2 text-sm font-medium transition-colors"
        :class="activeTab === 'llm'
          ? 'border-b-2 border-accent text-text-primary'
          : 'text-text-tertiary hover:text-text-secondary'"
        @click="activeTab = 'llm'"
      >
        LLM
      </button>
      <button
        class="px-4 pb-2 text-sm font-medium transition-colors"
        :class="activeTab === 'agent'
          ? 'border-b-2 border-accent text-text-primary'
          : 'text-text-tertiary hover:text-text-secondary'"
        @click="activeTab = 'agent'"
      >
        Agent
      </button>
      <button
        class="px-4 pb-2 text-sm font-medium transition-colors"
        :class="activeTab === 'prompts'
          ? 'border-b-2 border-accent text-text-primary'
          : 'text-text-tertiary hover:text-text-secondary'"
        @click="activeTab = 'prompts'"
      >
        Prompts
      </button>
    </div>

    <!-- Tab: LLM -->
    <div v-if="activeTab === 'llm'">
      <div v-if="configLoading" class="text-text-tertiary">Loading...</div>
      <div v-else-if="configError" class="text-accent-red">{{ configError }}</div>

      <div v-else-if="config" class="space-y-8">
        <!-- Connection -->
        <section>
          <h3 class="mb-3 text-sm font-medium text-text-secondary">Connection</h3>
          <div class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
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
            <div>
              <label class="mb-1 block text-xs text-text-tertiary">API Key</label>
              <input
                v-model="config.anthropic_api_key"
                type="password"
                class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
              />
            </div>
          </div>
        </section>

        <!-- Thinking Mode -->
        <section class="rounded-lg border border-border-default bg-bg-inset p-4">
          <h3 class="mb-3 text-sm font-medium text-text-secondary">Thinking Mode</h3>
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              v-model="config.thinking_enabled"
              class="h-4 w-4 rounded border-border-default bg-bg-inset"
            />
            <span class="text-sm text-text-secondary">Extended Thinking</span>
          </div>
          <div v-if="config.thinking_enabled" class="mt-3">
            <label class="mb-1 block text-xs text-text-tertiary">Budget Tokens</label>
            <input
              type="range"
              v-model.number="config.thinking_budget_tokens"
              min="1000"
              max="128000"
              step="1000"
              class="w-full"
            />
            <span class="text-xs text-text-tertiary">
              {{ config.thinking_budget_tokens?.toLocaleString() }} tokens
            </span>
            <p class="mt-1 text-xs text-text-tertiary">
              Controls model thinking depth. Higher = deeper thinking, slower responses, more token usage. Restart required.
            </p>
          </div>
          <p v-if="restartHint" class="mt-2 text-xs text-accent-yellow">
            Thinking config updated. Restart the app to apply changes.
          </p>
        </section>

        <!-- 保存 -->
        <div class="flex items-center gap-3">
          <button
            class="rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg-base transition-colors hover:bg-accent/80"
            :disabled="saving"
            @click="saveConfig"
          >
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
          <span v-if="success" class="text-xs text-accent">Saved. Restart to apply changes.</span>
        </div>
      </div>
    </div>

    <!-- Tab: Agent -->
    <div v-if="activeTab === 'agent'">
      <div v-if="configLoading" class="text-text-tertiary">Loading...</div>
      <div v-else-if="configError" class="text-accent-red">{{ configError }}</div>

      <div v-else-if="config" class="space-y-8">
        <!-- Runtime Parameters -->
        <section>
          <h3 class="mb-3 text-sm font-medium text-text-secondary">Runtime Parameters</h3>
          <div class="grid grid-cols-3 gap-3">
            <div v-for="field of [
              { key: 'max_turns', label: 'Max Turns', min: 1, max: 200, hint: '1 - 200' },
              { key: 'context_window', label: 'Context Window', min: 1000, max: 1000000, hint: '1K - 1M' },
              { key: 'max_output_tokens', label: 'Max Output Tokens', min: 256, max: 100000, hint: '256 - 100K' },
              { key: 'tool_output_max_bytes', label: 'Tool Output (bytes)', min: 1000, max: 1000000, hint: '1K - 1M' },
              { key: 'bash_default_timeout_secs', label: 'Bash Timeout (sec)', min: 1, max: 600, hint: '1 - 600' },
            ]" :key="field.key">
              <label class="mb-1 block text-xs text-text-tertiary">{{ field.label }}</label>
              <input
                v-model.number="config[field.key as keyof typeof config]"
                type="number"
                :min="field.min"
                :max="field.max"
                class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
              />
              <span class="text-[10px] text-text-tertiary">{{ field.hint }}</span>
            </div>
          </div>
        </section>

        <!-- 保存 -->
        <div class="flex items-center gap-3">
          <button
            class="rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg-base transition-colors hover:bg-accent/80"
            :disabled="saving"
            @click="saveConfig"
          >
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
          <span v-if="success" class="text-xs text-accent">Saved. Restart to apply changes.</span>
        </div>
      </div>
    </div>

    <!-- Tab: Prompts -->
    <div v-if="activeTab === 'prompts'">
      <div v-if="promptsLoading" class="text-text-tertiary">Loading...</div>
      <div v-else-if="promptsError" class="text-accent-red">{{ promptsError }}</div>
      <div v-else class="flex gap-6">
        <!-- 左侧列表区 -->
        <div class="w-1/2 space-y-6">
          <!-- Built-in Prompts -->
          <section>
            <h3 class="mb-3 text-sm font-medium text-text-secondary">Built-in Prompts</h3>
            <div class="space-y-2">
              <div
                v-for="prompt in builtinPrompts"
                :key="prompt.key"
                class="rounded-md border bg-bg-elevated px-4 py-3 transition-colors"
                :class="editTarget?.type === 'builtin' && editTarget.key === prompt.key
                  ? 'border-accent-blue'
                  : 'border-border-default'"
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-sm text-text-primary">{{ prompt.key }}</span>
                    <span class="text-xs" :class="modeColor(prompt.mode)">
                      [{{ prompt.mode }}]
                    </span>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      class="text-xs text-accent-blue hover:underline"
                      @click="handlePreview(prompt.key)"
                    >
                      Preview
                    </button>
                    <button
                      class="text-xs text-accent-blue hover:underline"
                      @click="editTarget = { type: 'builtin', key: prompt.key }; openEdit(prompt)"
                    >
                      Edit
                    </button>
                    <button
                      v-if="prompt.has_enhance || prompt.has_override"
                      class="text-xs text-accent-red hover:underline"
                      @click="handleDeletePrompt(prompt.key)"
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <p class="mt-1 text-xs text-text-tertiary">{{ promptDescription(prompt) }}</p>
              </div>
            </div>
          </section>

          <!-- Custom Agents -->
          <section>
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium text-text-secondary">Custom Agents</h3>
              <button
                class="text-xs text-accent-blue hover:underline"
                @click="editTarget = { type: 'new-agent' }"
              >
                + New Agent
              </button>
            </div>
            <div v-if="customPrompts.length === 0" class="text-xs text-text-tertiary">
              No custom agents yet.
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="agent in customPrompts"
                :key="agent.key"
                class="flex items-center justify-between rounded-md border bg-bg-elevated px-4 py-3 transition-colors"
                :class="editTarget?.type === 'custom' && editTarget.key === agent.key
                  ? 'border-accent-blue'
                  : 'border-border-default'"
              >
                <div>
                  <span class="font-mono text-sm text-text-primary">{{ agent.key }}</span>
                  <span class="ml-2 text-xs text-accent">[custom]</span>
                  <p v-if="agent.description" class="mt-1 text-xs text-text-tertiary">{{ agent.description }}</p>
                  <p v-else class="mt-1 text-xs text-text-tertiary">{{ promptDescription(agent) }}</p>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    class="text-xs text-accent-blue hover:underline"
                    @click="editTarget = { type: 'custom', key: agent.key }"
                  >
                    Edit
                  </button>
                  <button
                    class="text-xs text-accent-red hover:underline"
                    @click="handleDeleteAgent(agent.key)"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </section>

          <p v-if="restartHint" class="text-xs text-accent-yellow">
            Agent config updated. Restart the app for changes to take effect.
          </p>
        </div>

        <!-- 右侧编辑区（空状态占位） -->
        <div class="w-1/2 flex items-center justify-center rounded-md border border-border-default bg-bg-elevated">
          <span v-if="editTarget === null" class="text-sm text-text-tertiary">
            Select a prompt to edit
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
