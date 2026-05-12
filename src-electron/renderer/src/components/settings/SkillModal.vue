<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { Button, Input } from '../../design-system'
import type { SkillInfo } from '@xyz-agent/shared'

interface Props {
  visible: boolean
  skill?: SkillInfo | null
}

const props = withDefaults(defineProps<Props>(), {
  skill: null,
})

const emit = defineEmits<{
  close: []
  save: [data: { name: string; description: string; triggers: string[]; sourcePath: string }]
}>()

const formName = ref('')
const formDescription = ref('')
const formTriggers = ref('')
const formSourcePath = ref('')

watch(() => props.visible, (v) => {
  if (v) {
    if (props.skill) {
      formName.value = props.skill.name
      formDescription.value = props.skill.description
      formTriggers.value = props.skill.triggers.join(', ')
      formSourcePath.value = props.skill.sourcePath ?? ''
    } else {
      formName.value = ''
      formDescription.value = ''
      formTriggers.value = ''
      formSourcePath.value = ''
    }
  }
})

function handleSave() {
  emit('save', {
    name: formName.value.trim(),
    description: formDescription.value.trim(),
    triggers: formTriggers.value.split(',').map(s => s.trim()).filter(Boolean),
    sourcePath: formSourcePath.value.trim(),
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
    <div class="w-[600px] max-h-[85vh] bg-surface border border-border rounded overflow-hidden flex flex-col shadow-[0_8px_40px_rgba(0,0,0,0.12)]">
      <div class="flex items-center justify-between py-4 px-5 border-b border-border">
        <div class="font-display text-base font-semibold">{{ skill ? '编辑 Skill' : '添加 Skill' }}</div>
        <Button variant="ghost" class="!h-7 !w-7 !p-0 !rounded-xs !text-muted hover:!bg-accent-light hover:!text-accent" @click="$emit('close')">×</Button>
      </div>

      <div class="p-5 overflow-y-auto flex-1">
        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">Skill 名称</div>
          <Input v-model="formName" placeholder="例如：code-review" />
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">描述</div>
          <Input v-model="formDescription" placeholder="简要描述此 Skill 的功能" />
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">触发词 (逗号分隔)</div>
          <Input v-model="formTriggers" placeholder="例如：review, 代码审查, 检查代码" />
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">来源路径</div>
          <Input v-model="formSourcePath" placeholder="例如：~/.pi/agent/skills/code-review/" />
        </div>
      </div>

      <div class="flex justify-end gap-2 py-3.5 px-5 border-t border-border">
        <Button variant="outline" @click="$emit('close')">取消</Button>
        <Button variant="primary" @click="handleSave">{{ skill ? '保存' : '添加 Skill' }}</Button>
      </div>
    </div>
  </div>
</template>
