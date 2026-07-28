<script setup lang="ts">
import { useFormField } from './useFormField'

const { id, errorMessage, isInvalid } = useFormField()
</script>

<template>
  <div
    :id="id"
    :aria-describedby="errorMessage ? `${id}-message` : undefined"
    :aria-invalid="isInvalid"
  >
    <slot />
  </div>
</template>
