<script setup lang="ts">
import { provide } from 'vue'
import { useFormField } from './useFormField'

const ctx = useFormField()
provide('formField', ctx)
</script>

<template>
  <div class="space-y-2">
    <slot />
  </div>
</template>
