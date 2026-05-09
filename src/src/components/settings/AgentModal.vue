<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue'
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

onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div :class="['s-modal-overlay', { visible }]" @click.self="$emit('close')">
    <div class="s-modal">
      <div class="s-modal__hd">
        <div class="s-modal__title">{{ agent ? '编辑 Agent' : '添加 Agent' }}</div>
        <Button variant="ghost" class="s-modal__close" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </Button>
      </div>

      <div class="s-modal__bd">
        <div class="s-form-group">
          <div class="s-form-label">Agent 名称</div>
          <Input v-model="formName" placeholder="例如：code-reviewer" />
        </div>

        <div class="s-form-group">
          <div class="s-form-label">描述</div>
          <Input v-model="formDescription" placeholder="简要描述此 Agent 的职责" />
        </div>

        <div class="s-form-group">
          <div class="s-form-label">模型策略</div>
          <Select v-model="formStrategy" :options="strategyOptions" />
        </div>

        <div v-if="showModelBind" class="s-form-group">
          <div class="s-form-label">绑定模型</div>
          <Select v-model="formModelBind" :options="modelOptions" placeholder="选择模型" />
        </div>
      </div>

      <div class="s-modal__ft">
        <Button variant="ghost" @click="$emit('close')">取消</Button>
        <Button variant="primary" @click="handleSave">{{ agent ? '保存' : '添加 Agent' }}</Button>
      </div>
    </div>
  </div>
</template>
