<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button, Textarea } from '../../../design-system'

const { t } = useI18n()

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
  <div class="border border-border rounded-sm overflow-hidden">
    <div class="flex items-center justify-between py-1.5 px-3 bg-bg border-b border-border text-[11px] text-muted">
      <span>{{ props.filename }}</span>
      <Button size="sm" @click="$emit('save')">{{ t('common.save') }}</Button>
    </div>
    <Textarea
      class="w-full min-h-[200px] max-h-[400px] p-3 border-none bg-surface text-fg font-mono text-xs leading-relaxed resize-y outline-none placeholder:text-muted"
      :model-value="modelValue"
      :auto-resize="false"
      :rows="10"
      @update:model-value="$emit('update:modelValue', $event)"
    />
  </div>
</template>
