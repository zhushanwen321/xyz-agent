<script setup lang="ts">
 

const props = defineProps<{
  active: boolean
  params: { depth: number; width: number; tokens: number; rounds: number }
}>()

const emit = defineEmits<{
  'update:active': [value: boolean]
  'update:params': [value: { depth: number; width: number; tokens: number; rounds: number }]
}>()

function update(key: string, e: Event) {
  const val = Number((e.target as HTMLInputElement).value)
  emit('update:params', { ...props.params, [key]: val })
}
</script>

<template>
  <div class="override-section">
    <div
      :class="['override-toggle', { active }]"
      @click="$emit('update:active', !active)"
    >
      <span class="override-toggle__check">{{ active ? '\u2713' : '' }}</span>
      覆盖全局 SubAgent 参数
    </div>
    <div :class="['override-params', { disabled: !active }]">
      <div>
        <div class="override-params__label">深度</div>
        <input class="override-params__input" type="number" :value="params.depth" @input="update('depth', $event)">
      </div>
      <div>
        <div class="override-params__label">宽度</div>
        <input class="override-params__input" type="number" :value="params.width" @input="update('width', $event)">
      </div>
      <div>
        <div class="override-params__label">Token</div>
        <input class="override-params__input" type="number" :value="params.tokens" @input="update('tokens', $event)">
      </div>
      <div>
        <div class="override-params__label">轮次</div>
        <input class="override-params__input" type="number" :value="params.rounds" @input="update('rounds', $event)">
      </div>
    </div>
  </div>
</template>

<style scoped>
.override-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.override-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.override-toggle__check {
  width: 16px;
  height: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s var(--ease);
  font-size: 10px;
}

.override-toggle.active .override-toggle__check {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.override-params {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 8px;
}

.override-params.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.override-params__label {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 3px;
}

.override-params__input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s var(--ease);
}

.override-params__input:focus {
  border-color: var(--accent);
}
</style>
