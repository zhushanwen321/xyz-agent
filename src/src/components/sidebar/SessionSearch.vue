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
  <div class="session-search">
    <div class="search-input-wrap">
      <svg class="search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="4.5" />
        <line x1="10.2" y1="10.2" x2="14" y2="14" />
      </svg>
      <Input
        :model-value="modelValue"
        :placeholder="t('sidebar.searchSessions')"
        class="search-input"
        @update:model-value="emit('update:modelValue', $event)"
      />
      <Button
        v-if="hasValue"
        variant="ghost"
        class="clear-btn"
        :aria-label="t('sidebar.clearSearch')"
        @click="clear"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </Button>
    </div>
  </div>
</template>

<style scoped>
.session-search { padding: 8px 12px; }
.search-input-wrap { position: relative; display: flex; align-items: center; }
.search-icon {
  position: absolute; left: 10px; width: 14px; height: 14px;
  color: var(--muted); pointer-events: none; z-index: 1;
}
.search-input { flex: 1; }
.search-input :deep(input) { padding-left: 30px; }
.clear-btn {
  position: absolute; right: 6px; width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer;
  color: var(--muted); border-radius: var(--radius-sm);
  padding: 0;
}
.clear-btn:hover { color: var(--fg); background: var(--accent-light); }
.clear-btn svg { width: 12px; height: 12px; }
</style>
