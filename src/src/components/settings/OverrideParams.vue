<script setup lang="ts">
import { Input } from '../../design-system'

const props = defineProps<{
  active: boolean
  params: { depth: number; width: number; tokens: number; rounds: number }
}>()

const emit = defineEmits<{
  'update:active': [value: boolean]
  'update:params': [value: { depth: number; width: number; tokens: number; rounds: number }]
}>()

function update(key: string, val: string) {
  const num = Number(val)
  emit('update:params', { ...props.params, [key]: num })
}
</script>

<template>
  <div class="s-override-section">
    <div
      :class="['s-override-toggle', { active }]"
      @click="$emit('update:active', !active)"
    >
      <span class="s-override-toggle__check">{{ active ? '\u2713' : '' }}</span>
      覆盖全局 SubAgent 参数
    </div>
    <div :class="['s-override-params', { disabled: !active }]">
      <div>
        <div class="override-params__label">深度</div>
        <Input
          class="s-override-params__input"
          :model-value="String(params.depth)"
          @update:model-value="update('depth', $event)"
        />
      </div>
      <div>
        <div class="override-params__label">宽度</div>
        <Input
          class="s-override-params__input"
          :model-value="String(params.width)"
          @update:model-value="update('width', $event)"
        />
      </div>
      <div>
        <div class="override-params__label">Token</div>
        <Input
          class="s-override-params__input"
          :model-value="String(params.tokens)"
          @update:model-value="update('tokens', $event)"
        />
      </div>
      <div>
        <div class="override-params__label">轮次</div>
        <Input
          class="s-override-params__input"
          :model-value="String(params.rounds)"
          @update:model-value="update('rounds', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Component-specific label style, not in design system */
.override-params__label {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 3px;
}
</style>
