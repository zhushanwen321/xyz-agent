<script setup lang="ts">
import { ref } from 'vue'
import type { PromptSaveInput } from '../../types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

const props = defineProps<{
  promptKey: string
  builtinContent: string
}>()

const emit = defineEmits<{
  save: [input: PromptSaveInput]
  cancel: []
}>()

const editMode = ref<'enhance' | 'override'>('enhance')
const editContent = ref('')

function initContent(hasOverride: boolean, mode: string, promptContent: string, builtin: string) {
  editMode.value = hasOverride ? 'override' : 'enhance'
  if (editMode.value === 'enhance') {
    editContent.value = mode === 'enhance' ? promptContent : ''
  } else {
    editContent.value = builtin
  }
}

function switchMode(mode: 'enhance' | 'override') {
  editMode.value = mode
  editContent.value = mode === 'enhance' ? '' : props.builtinContent
}

function restoreOverride() {
  editContent.value = props.builtinContent
}

function handleSave() {
  const input: PromptSaveInput = {
    key: props.promptKey,
    mode: editMode.value,
    content: editContent.value,
  }
  emit('save', input)
}

function reset() {
  editContent.value = ''
  editMode.value = 'enhance'
}

defineExpose({ initContent, reset })
</script>

<template>
  <div class="space-y-3 p-4">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium text-muted-foreground">
        Edit: {{ promptKey }}
      </h3>
      <Button
        variant="ghost"
        class="text-xs text-tertiary hover:text-muted-foreground"
        @click="emit('cancel')"
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
        @click="switchMode('enhance')"
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
        @click="switchMode('override')"
      >
        Override
      </Button>
    </div>
    <!-- Enhance mode -->
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
    <!-- Override mode -->
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
        @click="emit('cancel')"
      >
        Cancel
      </Button>
      <Button
        class="font-mono text-xs"
        @click="handleSave"
      >
        Save
      </Button>
    </div>
  </div>
</template>
