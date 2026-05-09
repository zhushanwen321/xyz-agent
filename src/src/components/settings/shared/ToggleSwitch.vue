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
    class="s-toggle"
    :class="{ off: !modelValue }"
    @click="$emit('update:modelValue', !modelValue)"
  />
</template>
