<script setup lang="ts">
import { computed } from 'vue'
import { Input, Button } from '../../design-system'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { t } = useI18n()

const hasValue = computed(() => props.modelValue.length > 0)

function clear() {
  emit('update:modelValue', '')
}
</script>

<template>
  <div class="py-2 px-3">
    <div class="relative flex items-center">
      <svg class="absolute left-[10px] w-[14px] h-[14px] text-muted pointer-events-none z-[1]" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="4.5" />
        <line x1="10.2" y1="10.2" x2="14" y2="14" />
      </svg>
      <Input
        :model-value="modelValue"
        :placeholder="t('sidebar.searchSessions')"
        class="flex-1"
        @update:model-value="emit('update:modelValue', String($event))"
      />
      <Button
        v-if="hasValue"
        variant="ghost"
        class="absolute right-[6px] w-5 h-5 flex items-center justify-center bg-transparent border-none cursor-pointer text-muted rounded-sm p-0 hover:text-fg hover:bg-accent-light"
        :aria-label="t('sidebar.clearSearch')"
        @click="clear"
      >
        <svg class="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* :deep() is required to style the internal input element of the design-system Input component */
.flex-1 :deep(input) { padding-left: 30px; }
</style>
