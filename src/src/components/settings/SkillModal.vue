<script setup lang="ts">
import { ref, watch } from 'vue'
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
</script>

<template>
  <div :class="['modal-overlay', { visible }]" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal__hd">
        <div class="modal__title">{{ skill ? '编辑 Skill' : '添加 Skill' }}</div>
        <button class="modal__close" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>
      </div>

      <div class="modal__bd">
        <div class="form-group">
          <div class="form-group__label">Skill 名称</div>
          <input v-model="formName" class="form-input" placeholder="例如：code-review">
        </div>

        <div class="form-group">
          <div class="form-group__label">描述</div>
          <input v-model="formDescription" class="form-input" placeholder="简要描述此 Skill 的功能">
        </div>

        <div class="form-group">
          <div class="form-group__label">触发词 (逗号分隔)</div>
          <input v-model="formTriggers" class="form-input" placeholder="例如：review, 代码审查, 检查代码">
        </div>

        <div class="form-group">
          <div class="form-group__label">来源路径</div>
          <input v-model="formSourcePath" class="form-input" placeholder="例如：~/.pi/agent/skills/code-review/">
        </div>
      </div>

      <div class="modal__ft">
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn btn--primary" @click="handleSave">{{ skill ? '保存' : '添加 Skill' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s var(--ease);
}

.modal-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}

.modal {
  width: 480px;
  max-height: 85vh;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.12);
}

.modal__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal__title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
}

.modal__close {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: var(--radius-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s var(--ease);
}

.modal__close:hover {
  background: var(--accent-light);
  color: var(--accent);
}

.modal__bd {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.modal__ft {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}

.form-group {
  margin-bottom: 16px;
}

.form-group__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.form-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s var(--ease);
}

.form-input:focus {
  border-color: var(--accent);
}

.form-input::placeholder {
  color: var(--muted);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.2s var(--ease);
  white-space: nowrap;
}

.btn:hover {
  background: var(--accent-light);
  color: var(--accent);
  border-color: var(--accent);
}

.btn--primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.btn--primary:hover {
  opacity: 0.88;
}
</style>
