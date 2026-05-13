<script setup lang="ts">
const props = defineProps<{
  variant: 'power' | 'efficient' | 'fast'
  active: boolean
  readonly?: boolean
}>()

const variantClasses: Record<string, string> = {
  power: 'bg-[oklch(92%_0.04_25)] text-[oklch(55%_0.12_25)] border-[oklch(92%_0.04_25)]',
  efficient: 'bg-[oklch(92%_0.04_145)] text-[oklch(55%_0.12_145)] border-[oklch(92%_0.04_145)]',
  fast: 'bg-[oklch(92%_0.04_250)] text-[oklch(55%_0.12_250)] border-[oklch(92%_0.04_250)]',
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
