<script setup lang="ts">
/** UiInput：通用文本输入控件。
 * h-10 rounded-md border-input bg-input px-3 text-sm，focus = ring-1 ring-inset ring-accent-ring。*/
withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    type?: string
    mono?: boolean
  }>(),
  { modelValue: '', type: 'text', mono: false },
)
defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <input
    :type="type"
    class="ui-input"
    :class="{ mono }"
    :value="modelValue"
    :placeholder="placeholder"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.ui-input {
  height: 40px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 12px;
  font-size: 13px;
  color: var(--neutral-fg);
  width: 100%;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease),
    box-shadow var(--duration-fast) var(--ease);
}
.ui-input::placeholder {
  color: var(--neutral-mid);
}
.ui-input.mono {
  font-family: var(--font-mono);
}
.ui-input:focus {
  border-color: transparent;
  box-shadow: 0 0 0 1px var(--accent-ring) inset;
}
.ui-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-input.error {
  border-color: var(--danger);
}
.ui-input.error:focus {
  box-shadow: 0 0 0 1px var(--danger) inset;
}
</style>
