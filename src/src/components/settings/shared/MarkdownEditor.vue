<script setup lang="ts">
import { Button, Textarea } from '../../../design-system'

const props = withDefaults(
  defineProps<{
    modelValue: string
    filename?: string
  }>(),
  { filename: 'SKILL.md' },
)

defineEmits<{
  'update:modelValue': [value: string]
  save: []
}>()
</script>

<template>
  <div class="s-editor">
    <div class="s-editor__bar">
      <span>{{ props.filename }}</span>
      <Button variant="ghost" size="sm" @click="$emit('save')">保存</Button>
    </div>
    <Textarea
      class="s-editor__textarea"
      :model-value="modelValue"
      :auto-resize="false"
      :rows="10"
      @update:model-value="$emit('update:modelValue', $event)"
    />
  </div>
</template>
