<script setup lang="ts">
import type { ConfigResponse } from '../types'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  config: ConfigResponse | null
  saving: boolean
  success: boolean
}>()

const emit = defineEmits<{
  (e: 'save'): void
}>()
</script>

<template>
  <div>
    <div v-if="!config" class="text-text-tertiary">No config loaded.</div>

    <div v-else class="space-y-8">
      <!-- Runtime Parameters -->
      <section>
        <h3 class="mb-3 text-sm font-medium text-text-secondary">Runtime Parameters</h3>
        <div class="grid grid-cols-3 gap-3">
          <div v-for="field of [
            { key: 'max_turns', label: 'Max Turns', min: 1, max: 200, hint: '1 - 200' },
            { key: 'context_window', label: 'Context Window', min: 1000, max: 1000000, hint: '1K - 1M' },
            { key: 'max_output_tokens', label: 'Max Output Tokens', min: 256, max: 100000, hint: '256 - 100K' },
            { key: 'tool_output_max_bytes', label: 'Tool Output (bytes)', min: 1000, max: 1000000, hint: '1K - 1M' },
            { key: 'bash_default_timeout_secs', label: 'Bash Timeout (sec)', min: 1, max: 600, hint: '1 - 600' },
          ]" :key="field.key">
            <label class="mb-1 block text-xs text-text-tertiary">{{ field.label }}</label>
            <input
              v-model.number="config[field.key as keyof typeof config]"
              type="number"
              :min="field.min"
              :max="field.max"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            />
            <span class="text-[10px] text-text-tertiary">{{ field.hint }}</span>
          </div>
        </div>
      </section>

      <!-- 保存 -->
      <div class="flex items-center gap-3">
        <Button
          class="font-mono text-sm"
          :disabled="saving"
          @click="emit('save')"
        >
          {{ saving ? 'Saving...' : 'Save' }}
        </Button>
        <span v-if="success" class="text-xs text-accent">Saved.</span>
      </div>
    </div>
  </div>
</template>
