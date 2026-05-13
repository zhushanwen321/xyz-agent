<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Textarea } from '../../design-system'
import type { SkillInfo } from '@xyz-agent/shared'

interface Props {
  visible: boolean
  skill?: SkillInfo | null
}

const props = withDefaults(defineProps<Props>(), {
  skill: null,
})

const { t } = useI18n()

const emit = defineEmits<{
  close: []
  save: [data: { name: string; description: string; content: string }]
}>()

const formName = ref('')
const formDescription = ref('')
const formContent = ref('')

function parseDescriptionFromContent(content: string): string {
  const lines = content.split('\n')
  const fmLines: string[] = []
  let inFm = false
  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFm) { inFm = true; continue }
      break
    }
    if (inFm) fmLines.push(line)
  }
  return fmLines.join('\n').match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ?? ''
}

watch(() => props.visible, (v) => {
  if (v) {
    if (props.skill) {
      formName.value = props.skill.name
      formContent.value = props.skill.content ?? ''
      formDescription.value = parseDescriptionFromContent(formContent.value) || props.skill.description
    } else {
      formName.value = ''
      formDescription.value = ''
      formContent.value = ''
    }
  }
})

function handleSave() {
  emit('save', {
    name: formName.value.trim(),
    description: formDescription.value.trim(),
    content: formContent.value,
  })
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

watch(() => props.visible, (v) => {
  if (v) document.addEventListener('keydown', handleKeydown)
  else document.removeEventListener('keydown', handleKeydown)
})

onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div
    data-modal-overlay
    :data-modal-visible="visible || undefined"
    :class="[
      'fixed inset-0 bg-black/30 z-[100] flex items-center justify-center transition-opacity duration-200',
      visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
    ]"
    @click.self="$emit('close')"
  >
    <div class="w-[780px] max-h-[85vh] bg-surface border border-border rounded overflow-hidden flex flex-col shadow-[0_8px_40px_rgba(0,0,0,0.12)]">
      <div class="flex items-center justify-between py-4 px-5 border-b border-border">
        <div class="font-display text-base font-semibold">{{ skill ? t('settings.editSkill') : t('settings.addSkill') }}</div>
        <Button variant="ghost" class="!h-7 !w-7 !p-0 !rounded-xs !text-muted hover:!bg-accent-light hover:!text-accent" @click="$emit('close')">×</Button>
      </div>

      <div class="p-5 overflow-y-auto flex-1">
        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">{{ t('settings.skillName') }}</div>
          <Input v-model="formName" :placeholder="t('settings.skillNamePlaceholder')" />
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">{{ t('settings.skillDescription') }}</div>
          <Input v-model="formDescription" :placeholder="t('settings.skillDescriptionPlaceholder')" />
        </div>

        <div class="mb-1">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">{{ t('settings.skillContent') }}</div>
          <Textarea
            v-model="formContent"
            :auto-resize="false"
            :rows="32"
            class="!font-mono !text-[13px] !leading-relaxed !resize-y"
            :placeholder="t('settings.skillContentPlaceholder')"
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 py-3.5 px-5 border-t border-border">
        <Button variant="outline" @click="$emit('close')">{{ t('common.cancel') }}</Button>
        <Button variant="primary" @click="handleSave">{{ skill ? t('common.save') : t('settings.addSkill') }}</Button>
      </div>
    </div>
  </div>
</template>
