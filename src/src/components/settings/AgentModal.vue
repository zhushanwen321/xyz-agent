<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { Button, Input, Select } from '../../design-system'
import type { AgentInfo } from '@xyz-agent/shared'

interface ModelOption {
  id: string
  name: string
  providerName: string
}

interface Props {
  visible: boolean
  agent?: AgentInfo | null
  models: ModelOption[]
}

const props = withDefaults(defineProps<Props>(), {
  agent: null,
})

const emit = defineEmits<{
  close: []
  save: [data: { name: string; description: string; modelStrategy: string; modelBind?: string }]
}>()

const formName = ref('')
const formDescription = ref('')
const formStrategy = ref('auto')
const formModelBind = ref('')

const showModelBind = computed(() => formStrategy.value === 'bind')

const strategyOptions = [
  { label: '自动', value: 'auto' },
  { label: '标签', value: 'tag' },
  { label: '绑定', value: 'bind' },
]

const modelOptions = computed(() =>
  props.models.map(m => ({
    label: `${m.name} (${m.providerName})`,
    value: m.id,
  })),
)

watch(() => props.visible, (v) => {
  if (v) {
    if (props.agent) {
      formName.value = props.agent.name
      formDescription.value = props.agent.description
      formStrategy.value = props.agent.modelStrategy || 'auto'
      formModelBind.value = props.agent.modelBind ?? ''
    } else {
      formName.value = ''
      formDescription.value = ''
      formStrategy.value = 'auto'
      formModelBind.value = ''
    }
  }
})

function handleSave() {
  const data: { name: string; description: string; modelStrategy: string; modelBind?: string } = {
    name: formName.value.trim(),
    description: formDescription.value.trim(),
    modelStrategy: formStrategy.value,
  }
  if (formStrategy.value === 'bind' && formModelBind.value) {
    data.modelBind = formModelBind.value
  }
  emit('save', data)
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
        <div class="modal__title">{{ agent ? '编辑 Agent' : '添加 Agent' }}</div>
        <Button variant="ghost" class="modal__close" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </Button>
      </div>

      <div class="modal__bd">
        <div class="form-group">
          <div class="form-group__label">Agent 名称</div>
          <Input v-model="formName" class="form-input" placeholder="例如：code-reviewer" />
        </div>

        <div class="form-group">
          <div class="form-group__label">描述</div>
          <Input v-model="formDescription" class="form-input" placeholder="简要描述此 Agent 的职责" />
        </div>

        <div class="form-group">
          <div class="form-group__label">模型策略</div>
          <Select v-model="formStrategy" class="form-select" :options="strategyOptions" />
        </div>

        <div v-if="showModelBind" class="form-group">
          <div class="form-group__label">绑定模型</div>
          <Select v-model="formModelBind" class="form-select" :options="modelOptions" placeholder="选择模型" />
        </div>
      </div>

      <div class="modal__ft">
        <Button variant="ghost" @click="$emit('close')">取消</Button>
        <Button variant="primary" @click="handleSave">{{ agent ? '保存' : '添加 Agent' }}</Button>
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

.form-select {
  appearance: none;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 14px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s var(--ease);
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}

.form-select:focus {
  border-color: var(--accent);
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
