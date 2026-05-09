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
    class="s-agent-card__toggle"
    :class="{ off: !modelValue }"
    @click="$emit('update:modelValue', !modelValue)"
  />
</template>
