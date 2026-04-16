<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usePromptManager } from '../composables/usePromptManager'
import type { PromptInfo, PromptSaveInput, CustomAgentInput } from '../types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

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

// 提示词编辑状态
const editMode = ref<'enhance' | 'override'>('enhance')
const editContent = ref('')
const builtinContent = ref('')

// 编辑面板状态
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
const agentToolInput = ref('')
const restartHint = ref(false)

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

async function openEdit(prompt: PromptInfo) {
  editMode.value = prompt.has_override ? 'override' : 'enhance'
  try {
    builtinContent.value = await getPromptContent(prompt.key) || prompt.content
  } catch {
    builtinContent.value = prompt.content
  }
  if (editMode.value === 'enhance') {
    editContent.value = prompt.mode === 'enhance' ? prompt.content : ''
  } else {
    editContent.value = builtinContent.value
  }
}

function closeEdit() {
  editContent.value = ''
  builtinContent.value = ''
  editTarget.value = null
}

function restoreOverride() {
  editContent.value = builtinContent.value
}

async function handleSavePrompt() {
  if (!editTarget.value || editTarget.value.type !== 'builtin') return
  const input: PromptSaveInput = {
    key: editTarget.value.key,
    mode: editMode.value,
    content: editContent.value,
  }
  try {
    await savePrompt(input)
    closeEdit()
  } catch (e) {
    error.value = String(e)
  }
}

async function handleDeletePrompt(key: string) {
  try {
    await deletePrompt(key)
    if (editTarget.value?.type === 'builtin' && editTarget.value.key === key) {
      closeEdit()
    }
  } catch (e) {
    error.value = String(e)
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
    editTarget.value = null
    restartHint.value = true
  } catch (e) {
    error.value = String(e)
  }
}

async function handleDeleteAgent(name: string) {
  try {
    await deleteAgent(name)
    if (editTarget.value?.type === 'custom' && editTarget.value.key === name) {
      editTarget.value = null
    }
  } catch (e) {
    error.value = String(e)
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
              @click="editTarget = { type: 'builtin', key: prompt.key }; openEdit(prompt)"
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
        <div v-if="editTarget?.type === 'builtin'" class="space-y-3 p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium text-muted-foreground">
              Edit: {{ editTarget.key }}
            </h3>
            <Button
              variant="ghost"
              class="text-xs text-tertiary hover:text-muted-foreground"
              @click="closeEdit"
            >
              Cancel
            </Button>
          </div>
          <!-- Mode pills -->
          <div class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              class="rounded px-3 py-1 text-xs"
              :class="editMode === 'enhance'
                ? 'bg-semantic-blue/15 text-semantic-blue border-semantic-blue/30'
                : 'text-tertiary'"
              @click="editMode = 'enhance'; editContent = ''"
            >
              Enhance
            </Button>
            <Button
              variant="outline"
              size="sm"
              class="rounded px-3 py-1 text-xs"
              :class="editMode === 'override'
                ? 'bg-semantic-yellow/15 text-semantic-yellow border-semantic-yellow/30'
                : 'text-tertiary'"
              @click="editMode = 'override'; editContent = builtinContent"
            >
              Override
            </Button>
          </div>
          <!-- Enhance 模式 -->
          <template v-if="editMode === 'enhance'">
            <div>
              <label class="mb-1 block text-xs text-tertiary">Original Prompt</label>
              <pre class="whitespace-pre-wrap rounded-md border border-border-default bg-inset p-3 text-xs text-tertiary">{{ builtinContent }}</pre>
            </div>
            <div>
              <label class="mb-1 block text-xs text-tertiary">Append Content</label>
              <Textarea
                v-model="editContent"
                rows="6"
                class="font-mono text-xs"
                placeholder="Content appended after the original prompt..."
              />
            </div>
          </template>
          <!-- Override 模式 -->
          <template v-else>
            <div class="flex items-center justify-between">
              <label class="text-xs text-tertiary">Override Content</label>
              <Button
                variant="link"
                class="text-xs text-semantic-yellow"
                @click="restoreOverride"
              >
                Restore Original
              </Button>
            </div>
            <Textarea
              v-model="editContent"
              rows="12"
              class="font-mono text-xs"
            />
          </template>
          <div class="flex justify-end gap-2">
            <Button
              variant="outline"
              class="text-xs"
              @click="closeEdit"
            >
              Cancel
            </Button>
            <Button
              class="font-mono text-xs"
              @click="handleSavePrompt"
            >
              Save
            </Button>
          </div>
        </div>

        <!-- Custom agent 编辑/创建面板 -->
        <div v-if="editTarget?.type === 'custom' || editTarget?.type === 'new-agent'" class="space-y-3 p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium text-muted-foreground">
              {{ editTarget.type === 'new-agent' ? 'New Custom Agent' : 'Edit: ' + editTarget.key }}
            </h3>
            <Button
              variant="ghost"
              class="text-xs text-tertiary hover:text-muted-foreground"
              @click="editTarget = null; resetAgentForm()"
            >
              Cancel
            </Button>
          </div>
          <!-- Name -->
          <div>
            <label class="mb-1 block text-xs text-tertiary">Name</label>
            <Input v-model="agentForm.name" type="text"
              :disabled="editTarget.type === 'custom'"
              class="font-mono text-sm"
              placeholder="e.g. code_reviewer" />
          </div>
          <!-- Description -->
          <div>
            <label class="mb-1 block text-xs text-tertiary">Description</label>
            <Input v-model="agentForm.description" type="text"
              class="text-sm" />
          </div>
          <!-- Prompt -->
          <div>
            <label class="mb-1 block text-xs text-tertiary">Prompt Content</label>
            <Textarea v-model="agentForm.content" rows="10"
              class="font-mono text-xs" />
          </div>
          <!-- Tools -->
          <div>
            <label class="mb-1 block text-xs text-tertiary">Allowed Tools</label>
            <div class="flex items-center gap-2">
              <Input v-model="agentToolInput" type="text"
                class="flex-1 font-mono text-xs"
                placeholder="Tool name" @keydown.enter.prevent="addTool" />
              <Button variant="outline" class="text-xs" @click="addTool">Add</Button>
            </div>
            <div v-if="agentForm.tools.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="(tool, i) in agentForm.tools" :key="i"
                class="inline-flex items-center gap-1 rounded bg-inset px-2 py-0.5 text-xs text-muted-foreground">
                {{ tool }} <Button variant="ghost" size="sm" class="h-auto p-0 text-semantic-red text-xs hover:bg-transparent" @click="removeTool(i)">x</Button>
              </span>
            </div>
          </div>
          <!-- Budget -->
          <div>
            <label class="mb-1 block text-xs text-tertiary">Budget</label>
            <div class="grid grid-cols-3 gap-2">
              <div>
                <label class="text-xs text-tertiary">Max Tokens</label>
                <Input v-model.number="agentForm.max_tokens" type="number" min="1000" max="500000"
                  class="font-mono text-xs" />
              </div>
              <div>
                <label class="text-xs text-tertiary">Max Turns</label>
                <Input v-model.number="agentForm.max_turns" type="number" min="1" max="200"
                  class="font-mono text-xs" />
              </div>
              <div>
                <label class="text-xs text-tertiary">Max Tool Calls</label>
                <Input v-model.number="agentForm.max_tool_calls" type="number" min="1" max="500"
                  class="font-mono text-xs" />
              </div>
            </div>
          </div>
          <!-- Read-only -->
          <div class="flex items-center gap-2">
            <Checkbox v-model:checked="agentForm.read_only" />
            <span class="text-sm text-muted-foreground">Read-only</span>
          </div>
          <!-- Actions -->
          <div class="flex justify-end gap-2">
            <Button
              variant="outline"
              class="text-xs"
              @click="editTarget = null; resetAgentForm()"
            >
              Cancel
            </Button>
            <Button
              class="font-mono text-xs"
              @click="handleSaveAgent"
            >
              {{ editTarget.type === 'new-agent' ? 'Create' : 'Save' }}
            </Button>
          </div>
        </div>

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
