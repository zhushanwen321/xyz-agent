<script setup lang="ts">
import { computed } from 'vue'
import { useFormField } from './useFormField'

const { id, errorMessage, isInvalid } = useFormField()
const visible = computed(() => isInvalid && errorMessage.value)
</script>

<template>
  <p
    v-if="visible"
    :id="`${id}-message`"
    class="text-[12px] font-medium text-danger"
  >
    {{ errorMessage }}
  </p>
</template>
