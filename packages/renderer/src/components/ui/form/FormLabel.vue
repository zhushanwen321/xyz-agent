<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Label } from 'reka-ui'
import { cn } from '@/lib/utils'
import { useFormField } from './useFormField'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const { id } = useFormField()
</script>

<template>
  <Label
    :for="id"
    :class="cn('text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', props.class)"
  >
    <slot />
  </Label>
</template>
