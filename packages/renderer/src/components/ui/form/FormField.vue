<script setup lang="ts">
import { Field } from 'vee-validate'

const props = defineProps<{
  name: string
}>()
</script>

<template>
  <Field v-slot="slotProps" :name="props.name">
    <slot
      :componentField="{
        id: slotProps.field.name,
        name: slotProps.field.name,
        modelValue: slotProps.field.value,
        'onUpdate:modelValue': slotProps.handleChange,
        onBlur: slotProps.handleBlur,
      }"
    />
  </Field>
</template>
