<script setup lang="ts">
 

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
      <button class="btn btn--sm" @click="$emit('save')">保存</button>
    </div>
    <textarea
      class="md-editor__textarea"
      :value="modelValue"
      spellcheck="false"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
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
  width: 100%;
  min-height: 200px;
  max-height: 400px;
  padding: 12px;
  border: none;
  background: var(--surface);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
}

.md-editor__textarea::placeholder {
  color: var(--muted);
}
</style>
