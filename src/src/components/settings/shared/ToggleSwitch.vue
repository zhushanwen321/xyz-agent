<script setup lang="ts">
 

defineProps<{
  modelValue: boolean
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <div
    class="toggle-switch"
    :class="{ off: !modelValue }"
    @click="$emit('update:modelValue', !modelValue)"
  />
</template>

<style scoped>
.toggle-switch {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--success);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s var(--ease);
}

.toggle-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 18px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: left 0.2s var(--ease);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.toggle-switch.off {
  background: var(--border);
}

.toggle-switch.off::after {
  left: 2px;
}
</style>
