<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usePromptManager } from '../composables/usePromptManager'
import type { PromptInfo, PromptSaveInput, CustomAgentInput } from '../types'
import { Button } from '@/components/ui/button'
import BuiltinPromptEditor from './prompts/BuiltinPromptEditor.vue'
import AgentFormEditor from './prompts/AgentFormEditor.vue'

const {
  prompts,
  loading: promptsLoading,
  error: promptsError,
  load: loadPrompts,
  get: getPromptContent,
  save: savePrompt,
  remove: deletePrompt,
  saveAgent,
  deleteAgent,
} = usePromptManager()

const error = ref<string | null>(null)
const builtinContent = ref('')
const restartHint = ref(false)

type EditTarget =
  | { type: 'builtin'; key: string }
  | { type: 'custom'; key: string }
  | { type: 'new-agent' }
  | null
const editTarget = ref<EditTarget>(null)

const DEFAULT_AGENT_FORM: CustomAgentInput = {
  name: '', content: '', tools: [],
  description: '', read_only: false,
  max_tokens: 100_000, max_turns: 30, max_tool_calls: 100,
}
const agentForm = ref<CustomAgentInput>({ ...DEFAULT_AGENT_FORM })

const builtinEditorRef = ref<InstanceType<typeof BuiltinPromptEditor> | null>(null)

const builtinPrompts = computed(() => prompts.value.filter(p => p.mode !== 'custom'))
const customPrompts = computed(() => prompts.value.filter(p => p.mode === 'custom'))

function promptDescription(prompt: PromptInfo): string {
  const text = prompt.content.trim()
  const firstLine = text.split('\n').find(l => l.trim().length > 0) || ''
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
}

function modeColor(mode: string): string {
  switch (mode) {
    case 'enhance': return 'text-semantic-blue'
    case 'override': return 'text-semantic-yellow'
    case 'custom': return 'text-semantic-green'
    default: return 'text-tertiary'
  }
}

async function openBuiltinEdit(prompt: PromptInfo) {
  editTarget.value = { type: 'builtin', key: prompt.key }
  try {
    builtinContent.value = await getPromptContent(prompt.key) || prompt.content
  } catch {
    builtinContent.value = prompt.content
  }
  builtinEditorRef.value?.initContent(
    prompt.has_override, prompt.mode, prompt.content, builtinContent.value,
  )
}

function closeEdit() {
  builtinContent.value = ''
  editTarget.value = null
}

async function handleSavePrompt(input: PromptSaveInput) {
  try {
    await savePrompt(input)
    closeEdit()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function handleDeletePrompt(key: string) {
  try {
    await deletePrompt(key)
    if (editTarget.value?.type === 'builtin' && editTarget.value.key === key) {
      closeEdit()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function openEditAgent(agent: PromptInfo) {
  editTarget.value = { type: 'custom', key: agent.key }
  agentForm.value = {
    name: agent.key,
    content: agent.content,
    tools: [...agent.tools],
    description: agent.description,
    read_only: agent.read_only,
    max_tokens: agent.max_tokens,
    max_turns: agent.max_turns,
    max_tool_calls: agent.max_tool_calls,
  }
}

function resetAgentForm() {
  agentForm.value = { ...DEFAULT_AGENT_FORM }
}

async function handleSaveAgent() {
  try {
    await saveAgent(agentForm.value)
    editTarget.value = null
    restartHint.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function handleDeleteAgent(name: string) {
  try {
    await deleteAgent(name)
    if (editTarget.value?.type === 'custom' && editTarget.value.key === name) {
      editTarget.value = null
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(() => {
  loadPrompts()
})
</script>

<template>
  <div>
    <!-- 错误提示 -->
    <div v-if="error" class="mb-4 rounded-md border border-semantic-red/30 bg-semantic-red/10 px-4 py-3">
      <p class="text-sm text-semantic-red">{{ error }}</p>
    </div>

    <div v-if="promptsLoading" class="text-tertiary">Loading...</div>
    <div v-else-if="promptsError" class="text-semantic-red">{{ promptsError }}</div>
    <div v-else class="flex gap-6">
      <!-- 左侧列表区 -->
      <div class="w-1/2 space-y-6">
        <!-- Built-in Prompts -->
        <section>
          <h3 class="mb-3 text-sm font-medium text-muted-foreground">Built-in Prompts</h3>
          <div class="space-y-2">
            <div
              v-for="prompt in builtinPrompts"
              :key="prompt.key"
              class="cursor-pointer rounded-md border bg-elevated px-4 py-3 transition-colors"
              :class="editTarget?.type === 'builtin' && editTarget.key === prompt.key
                ? 'border-semantic-blue'
                : 'border-border-default'"
              @click="openBuiltinEdit(prompt)"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-sm text-foreground">{{ prompt.key }}</span>
                  <span class="text-xs" :class="modeColor(prompt.mode)">
                    [{{ prompt.mode }}]
                  </span>
                </div>
                <Button
                  v-if="prompt.has_enhance || prompt.has_override"
                  variant="link"
                  class="text-xs text-semantic-red"
                  @click.stop="handleDeletePrompt(prompt.key)"
                >
                  Reset
                </Button>
              </div>
              <p class="mt-1 text-xs text-tertiary">{{ promptDescription(prompt) }}</p>
            </div>
          </div>
        </section>

        <!-- Custom Agents -->
        <section>
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium text-muted-foreground">Custom Agents</h3>
            <Button
              variant="link"
              class="text-xs text-semantic-blue"
              @click="resetAgentForm(); editTarget = { type: 'new-agent' }"
            >
              + New Agent
            </Button>
          </div>
          <div v-if="customPrompts.length === 0" class="text-xs text-tertiary">
            No custom agents yet.
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="agent in customPrompts"
              :key="agent.key"
              class="flex items-center justify-between cursor-pointer rounded-md border bg-elevated px-4 py-3 transition-colors"
              :class="editTarget?.type === 'custom' && editTarget.key === agent.key
                ? 'border-semantic-blue'
                : 'border-border-default'"
              @click="openEditAgent(agent)"
            >
              <div>
                <span class="font-mono text-sm text-foreground">{{ agent.key }}</span>
                <span class="ml-2 text-xs text-semantic-green">[custom]</span>
                <p v-if="agent.description" class="mt-1 text-xs text-tertiary">{{ agent.description }}</p>
                <p v-else class="mt-1 text-xs text-tertiary">{{ promptDescription(agent) }}</p>
              </div>
              <Button
                variant="link"
                class="text-xs text-semantic-red"
                @click.stop="handleDeleteAgent(agent.key)"
              >
                Delete
              </Button>
            </div>
          </div>
        </section>

        <p v-if="restartHint" class="text-xs text-semantic-yellow">
          Agent config updated. Restart the app for changes to take effect.
        </p>
      </div>

      <!-- 右侧编辑区 -->
      <div class="w-1/2 rounded-md border border-border-default bg-elevated overflow-y-auto max-h-[calc(100vh-12rem)]">
        <!-- Builtin prompt 编辑面板 -->
        <BuiltinPromptEditor
          v-if="editTarget?.type === 'builtin'"
          ref="builtinEditorRef"
          :prompt-key="editTarget.key"
          :builtin-content="builtinContent"
          @save="handleSavePrompt"
          @cancel="closeEdit"
        />

        <!-- Custom agent 编辑/创建面板 -->
        <AgentFormEditor
          v-else-if="editTarget?.type === 'custom' || editTarget?.type === 'new-agent'"
          :model-value="agentForm"
          :is-new="editTarget.type === 'new-agent'"
          :edit-key="editTarget.type === 'custom' ? editTarget.key : ''"
          @update:model-value="agentForm = $event"
          @save="handleSaveAgent"
          @cancel="editTarget = null; resetAgentForm()"
        />

        <!-- 空状态 -->
        <div v-else class="flex h-full items-center justify-center p-4">
          <span class="text-sm text-tertiary">
            Select a prompt to edit
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
