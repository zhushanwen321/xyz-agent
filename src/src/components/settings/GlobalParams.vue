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
  <div class="global-params">
    <div class="global-params__title">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5M8 10.5v.5" />
      </svg>
      SubAgent 默认参数
    </div>
    <div class="params-grid">
      <div class="param-item">
        <div class="param-item__label">最大深度</div>
        <Input
          class="param-item__input"
          :model-value="String(modelValue.depth)"
          @update:model-value="update('depth', $event)"
        />
      </div>
      <div class="param-item">
        <div class="param-item__label">最大宽度</div>
        <Input
          class="param-item__input"
          :model-value="String(modelValue.width)"
          @update:model-value="update('width', $event)"
        />
      </div>
      <div class="param-item">
        <div class="param-item__label">Token 上限</div>
        <Input
          class="param-item__input"
          :model-value="String(modelValue.tokens)"
          @update:model-value="update('tokens', $event)"
        />
      </div>
      <div class="param-item">
        <div class="param-item__label">最大轮次</div>
        <Input
          class="param-item__input"
          :model-value="String(modelValue.rounds)"
          @update:model-value="update('rounds', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.global-params {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  margin-bottom: 24px;
}

.global-params__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.global-params__title svg {
  width: 14px;
  height: 14px;
  color: var(--muted);
}

.params-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.param-item__label {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
  font-weight: 500;
}

.param-item__input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s var(--ease);
}

.param-item__input:focus {
  border-color: var(--accent);
}
</style>
