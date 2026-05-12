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
    class="relative w-9 h-5 rounded-full cursor-pointer shrink-0 transition-[background] duration-200 ease-ease"
    :class="modelValue ? 'bg-success' : 'bg-border'"
    tabindex="0"
    role="switch"
    :aria-checked="modelValue"
    @click.stop="$emit('update:modelValue', !modelValue)"
    @keydown.enter="$emit('update:modelValue', !modelValue)"
    @keydown.space.prevent="$emit('update:modelValue', !modelValue)"
  >
    <span
      class="absolute top-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-[left] duration-200 ease-ease"
      :class="modelValue ? 'left-[18px]' : 'left-[2px]'"
    />
  </div>
</template>
