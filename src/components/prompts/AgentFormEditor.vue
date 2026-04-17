<script setup lang="ts">
import { ref, watch } from 'vue'
import type { CustomAgentInput } from '../../types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const props = defineProps<{
  modelValue: CustomAgentInput
  isNew: boolean
  editKey: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: CustomAgentInput]
  save: []
  cancel: []
}>()

const agentToolInput = ref('')

// 使用 local proxy 避免直接修改 props
const form = ref<CustomAgentInput>({ ...props.modelValue })
watch(() => props.modelValue, (val) => { form.value = { ...val } }, { deep: true })

function updateField<K extends keyof CustomAgentInput>(key: K, value: CustomAgentInput[K]) {
  ;(form.value as Record<string, unknown>)[key] = value
  emit('update:modelValue', { ...form.value })
}

function addTool() {
  const tool = agentToolInput.value.trim()
  if (tool && !form.value.tools.includes(tool)) {
    form.value.tools.push(tool)
    agentToolInput.value = ''
    emit('update:modelValue', { ...form.value })
  }
}

function removeTool(index: number) {
  form.value.tools.splice(index, 1)
  emit('update:modelValue', { ...form.value })
}
</script>

<template>
  <div class="space-y-3 p-4">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium text-muted-foreground">
        {{ isNew ? 'New Custom Agent' : 'Edit: ' + editKey }}
      </h3>
      <Button
        variant="ghost"
        class="text-xs text-tertiary hover:text-muted-foreground"
        @click="emit('cancel')"
      >
        Cancel
      </Button>
    </div>
    <!-- Name -->
    <div>
      <label class="mb-1 block text-xs text-tertiary">Name</label>
      <Input
        :model-value="form.name"
        type="text"
        :disabled="!isNew"
        class="font-mono text-sm"
        placeholder="e.g. code_reviewer"
        @update:model-value="updateField('name', String($event))"
      />
    </div>
    <!-- Description -->
    <div>
      <label class="mb-1 block text-xs text-tertiary">Description</label>
      <Input
        :model-value="form.description"
        type="text"
        class="text-sm"
        @update:model-value="updateField('description', String($event))"
      />
    </div>
    <!-- Prompt -->
    <div>
      <label class="mb-1 block text-xs text-tertiary">Prompt Content</label>
      <Textarea
        :model-value="form.content"
        rows="10"
        class="font-mono text-xs"
        @update:model-value="updateField('content', String($event))"
      />
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
      <div v-if="form.tools.length" class="mt-2 flex flex-wrap gap-1">
        <span v-for="(tool, i) in form.tools" :key="i"
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
          <Input
            :model-value="form.max_tokens"
            type="number" min="1000" max="500000"
            class="font-mono text-xs"
            @update:model-value="updateField('max_tokens', Number($event))"
          />
        </div>
        <div>
          <label class="text-xs text-tertiary">Max Turns</label>
          <Input
            :model-value="form.max_turns"
            type="number" min="1" max="200"
            class="font-mono text-xs"
            @update:model-value="updateField('max_turns', Number($event))"
          />
        </div>
        <div>
          <label class="text-xs text-tertiary">Max Tool Calls</label>
          <Input
            :model-value="form.max_tool_calls"
            type="number" min="1" max="500"
            class="font-mono text-xs"
            @update:model-value="updateField('max_tool_calls', Number($event))"
          />
        </div>
      </div>
    </div>
    <!-- Read-only -->
    <div class="flex items-center gap-2">
      <Checkbox
        :checked="form.read_only"
        @update:checked="updateField('read_only', $event)"
      />
      <span class="text-sm text-muted-foreground">Read-only</span>
    </div>
    <!-- Actions -->
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
        @click="emit('save')"
      >
        {{ isNew ? 'Create' : 'Save' }}
      </Button>
    </div>
  </div>
</template>
