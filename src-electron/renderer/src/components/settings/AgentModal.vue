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
        <div class="font-display text-base font-semibold">{{ agent ? '编辑 Agent' : '添加 Agent' }}</div>
        <Button variant="ghost" class="!h-7 !w-7 !p-0 !rounded-xs !text-muted hover:!bg-accent-light hover:!text-accent" @click="$emit('close')">×</Button>
      </div>

      <div class="p-5 overflow-y-auto flex-1">
        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">Agent 名称</div>
          <Input v-model="formName" placeholder="例如：code-reviewer" />
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">描述</div>
          <Input v-model="formDescription" placeholder="简要描述此 Agent 的职责" />
        </div>

        <div class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">模型策略</div>
          <Select v-model="formStrategy" :options="strategyOptions" />
        </div>

        <div v-if="showModelBind" class="mb-4">
          <div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">绑定模型</div>
          <Select v-model="formModelBind" :options="modelOptions" placeholder="选择模型" />
        </div>
      </div>

      <div class="flex justify-end gap-2 py-3.5 px-5 border-t border-border">
        <Button variant="outline" @click="$emit('close')">取消</Button>
        <Button variant="primary" @click="handleSave">{{ agent ? '保存' : '添加 Agent' }}</Button>
      </div>
    </div>
  </div>
</template>
