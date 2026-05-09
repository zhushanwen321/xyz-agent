<script setup lang="ts">
import { Input } from '../../design-system'

const props = defineProps<{
  modelValue: { depth: number; width: number; tokens: number; rounds: number }
}>()

const emit = defineEmits<{
  'update:modelValue': [value: { depth: number; width: number; tokens: number; rounds: number }]
}>()

function update(key: string, val: string) {
  const num = Number(val)
  emit('update:modelValue', { ...props.modelValue, [key]: num })
}
</script>

<template>
  <div class="s-global-params">
    <div class="s-global-params__title">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5M8 10.5v.5" />
      </svg>
      SubAgent 默认参数
    </div>
    <div class="s-params-grid">
      <div class="param-item">
        <div class="s-param-item__label">最大深度</div>
        <Input
          class="s-param-item__input"
          :model-value="String(modelValue.depth)"
          @update:model-value="update('depth', $event)"
        />
      </div>
      <div class="param-item">
        <div class="s-param-item__label">最大宽度</div>
        <Input
          class="s-param-item__input"
          :model-value="String(modelValue.width)"
          @update:model-value="update('width', $event)"
        />
      </div>
      <div class="param-item">
        <div class="s-param-item__label">Token 上限</div>
        <Input
          class="s-param-item__input"
          :model-value="String(modelValue.tokens)"
          @update:model-value="update('tokens', $event)"
        />
      </div>
      <div class="param-item">
        <div class="s-param-item__label">最大轮次</div>
        <Input
          class="s-param-item__input"
          :model-value="String(modelValue.rounds)"
          @update:model-value="update('rounds', $event)"
        />
      </div>
    </div>
  </div>
</template>


