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
  <div :class="['s-modal-overlay', { visible }]" @click.self="$emit('close')">
    <div class="s-modal">
      <div class="s-modal__hd">
        <div class="s-modal__title">{{ skill ? '编辑 Skill' : '添加 Skill' }}</div>
        <Button variant="ghost" class="s-modal__close !h-7 !w-7 !border-0 !p-0" @click="$emit('close')">×</Button>
      </div>

      <div class="s-modal__bd">
        <div class="s-form-group">
          <div class="s-form-label">Skill 名称</div>
          <Input v-model="formName" placeholder="例如：code-review" />
        </div>

        <div class="s-form-group">
          <div class="s-form-label">描述</div>
          <Input v-model="formDescription" placeholder="简要描述此 Skill 的功能" />
        </div>

        <div class="s-form-group">
          <div class="s-form-label">触发词 (逗号分隔)</div>
          <Input v-model="formTriggers" placeholder="例如：review, 代码审查, 检查代码" />
        </div>

        <div class="s-form-group">
          <div class="s-form-label">来源路径</div>
          <Input v-model="formSourcePath" placeholder="例如：~/.pi/agent/skills/code-review/" />
        </div>
      </div>

      <div class="s-modal__ft">
        <Button variant="ghost" @click="$emit('close')">取消</Button>
        <Button variant="primary" @click="handleSave">{{ skill ? '保存' : '添加 Skill' }}</Button>
      </div>
    </div>
  </div>
</template>
