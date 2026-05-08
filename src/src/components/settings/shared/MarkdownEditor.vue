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
  <div class="md-editor">
    <div class="md-editor__bar">
      <span>{{ props.filename }}</span>
      <Button variant="ghost" size="sm" @click="$emit('save')">保存</Button>
    </div>
    <Textarea
      class="md-editor__textarea"
      :model-value="modelValue"
      :auto-resize="false"
      :rows="10"
      @update:model-value="$emit('update:modelValue', $event)"
    />
  </div>
</template>

<style scoped>
.md-editor {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.md-editor__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
}

.md-editor__textarea {
  min-height: 200px;
  max-height: 400px;
  border: none;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}
</style>
