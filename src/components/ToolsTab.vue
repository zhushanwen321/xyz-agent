<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useToolManager } from '../composables/useToolManager'
import type { ToolInfo, ToolConfigSaveInput } from '../types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const {
  tools,
  loading: toolsLoading,
  error: toolsError,
  load: loadTools,
  save: saveToolConfig,
  reset: resetToolConfig,
} = useToolManager()

const error = ref<string | null>(null)
const selectedTool = ref<ToolInfo | null>(null)
const toolEditForm = ref<ToolConfigSaveInput>({ name: '' })
const toolRestartHint = ref(false)

function selectTool(tool: ToolInfo) {
  selectedTool.value = tool
  toolEditForm.value = {
    name: tool.name,
    description: tool.description,
    timeout_secs: tool.timeout_secs,
    enabled: tool.enabled,
  }
}

function deselectTool() {
  selectedTool.value = null
  toolEditForm.value = { name: '' }
}

async function handleSaveTool() {
  try {
    await saveToolConfig(toolEditForm.value)
    toolRestartHint.value = true
    deselectTool()
  } catch (e) {
    error.value = String(e)
  }
}

async function handleResetTool(name: string) {
  try {
    await resetToolConfig(name)
    if (selectedTool.value?.name === name) {
      deselectTool()
    }
  } catch (e) {
    error.value = String(e)
  }
}

onMounted(() => {
  loadTools()
})
</script>

<template>
  <div>
    <!-- 错误提示 -->
    <div v-if="error" class="mb-4 rounded-md border border-semantic-red/30 bg-semantic-red/10 px-4 py-3">
      <p class="text-sm text-semantic-red">{{ error }}</p>
    </div>

    <div v-if="toolsLoading" class="text-tertiary">Loading...</div>
    <div v-else-if="toolsError" class="text-semantic-red">{{ toolsError }}</div>
    <div v-else class="flex gap-6">
      <!-- 左侧列表区 -->
      <div class="w-1/2 space-y-6">
        <section>
          <h3 class="mb-3 text-sm font-medium text-muted-foreground">Tools</h3>
          <div class="space-y-2">
            <div
              v-for="tool in tools"
              :key="tool.name"
              class="cursor-pointer rounded-md border bg-elevated px-4 py-3 transition-colors"
              :class="selectedTool?.name === tool.name
                ? 'border-semantic-blue'
                : 'border-border-default'"
              @click="selectTool(tool)"
            >
              <div class="flex items-center gap-2">
                <span class="font-mono text-sm text-foreground">{{ tool.name }}</span>
                <span
                  class="text-xs"
                  :class="tool.danger_level === 'safe' ? 'text-semantic-blue' : 'text-semantic-yellow'"
                >[{{ tool.danger_level }}]</span>
                <span v-if="!tool.enabled" class="text-xs text-tertiary">[disabled]</span>
              </div>
            </div>
          </div>
        </section>
        <p v-if="toolRestartHint" class="text-xs text-semantic-yellow">
          Tool config updated. Restart the app for changes to take effect.
        </p>
      </div>

      <!-- 右侧编辑面板 -->
      <div class="w-1/2 rounded-md border border-border-default bg-elevated overflow-y-auto max-h-[calc(100vh-12rem)]">
        <div v-if="selectedTool" class="space-y-3 p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium text-muted-foreground">
              {{ selectedTool.name }}
            </h3>
            <Button
              v-if="selectedTool.has_override"
              variant="link"
              class="text-xs text-semantic-red"
              @click="handleResetTool(selectedTool.name)"
            >
              Reset
            </Button>
          </div>
          <!-- Enabled toggle -->
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              v-model="toolEditForm.enabled"
              class="h-4 w-4 rounded border-border-default bg-inset"
            />
            <span class="text-sm text-muted-foreground">Enabled</span>
          </div>
          <!-- Description -->
          <div>
            <label class="mb-1 block text-xs text-tertiary">Description</label>
            <Textarea
              v-model="toolEditForm.description"
              rows="8"
              class="font-mono text-xs"
            />
          </div>
          <!-- Timeout -->
          <div>
            <label class="mb-1 block text-xs text-tertiary">Timeout (sec)</label>
            <input
              v-model.number="toolEditForm.timeout_secs"
              type="number"
              min="1"
              max="600"
              class="w-full rounded-md border border-border-default bg-inset px-3 py-2 font-mono text-sm text-foreground"
            />
          </div>
          <!-- 只读信息 -->
          <div class="space-y-2 text-xs text-tertiary">
            <div>
              <span class="font-medium text-muted-foreground">Concurrent Safe:</span>
              {{ selectedTool.is_concurrent_safe ? 'Yes' : 'No' }}
            </div>
            <div>
              <span class="font-medium text-muted-foreground">Danger Level:</span>
              {{ selectedTool.danger_level }}
            </div>
            <div>
              <span class="font-medium text-muted-foreground">Input Schema:</span>
            </div>
            <pre class="whitespace-pre-wrap break-words rounded-md border border-border-default bg-inset p-3 text-xs text-tertiary">{{ JSON.stringify(selectedTool.input_schema, null, 2) }}</pre>
          </div>
          <!-- Actions -->
          <div class="flex justify-end gap-2">
            <Button
              variant="outline"
              class="text-xs"
              @click="deselectTool"
            >
              Cancel
            </Button>
            <Button
              class="font-mono text-xs"
              @click="handleSaveTool"
            >
              Save
            </Button>
          </div>
        </div>
        <!-- 空状态 -->
        <div v-else class="flex h-full items-center justify-center p-4">
          <span class="text-sm text-tertiary">
            Select a tool to view details
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
