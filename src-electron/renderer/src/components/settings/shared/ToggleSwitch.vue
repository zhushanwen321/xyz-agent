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
    @click.stop="$emit('update:modelValue', !modelValue)"
  />
</template>
