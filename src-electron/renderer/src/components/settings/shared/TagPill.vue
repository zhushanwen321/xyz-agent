<script setup lang="ts">
const props = defineProps<{
  variant: 'power' | 'efficient' | 'fast'
  active: boolean
  readonly?: boolean
}>()

const variantClasses: Record<string, string> = {
  power: 'bg-[oklch(65%_0.18_25)] text-white border-[oklch(65%_0.18_25)]',
  efficient: 'bg-[oklch(60%_0.15_260)] text-white border-[oklch(60%_0.15_260)]',
  fast: 'bg-[oklch(68%_0.16_145)] text-white border-[oklch(68%_0.16_145)]',
}

defineEmits<{
  toggle: []
}>()
</script>

<template>
  <span
    :class="[
      'px-2 rounded-full text-[10px] font-semibold cursor-pointer border bg-transparent text-muted transition-all duration-150 ease-ease select-none',
      active ? variantClasses[variant] : 'border-border hover:border-muted',
      props.readonly && 'cursor-default hover:border-border',
    ]"
    @click="!props.readonly && $emit('toggle')"
  >
    <slot />
  </span>
</template>
