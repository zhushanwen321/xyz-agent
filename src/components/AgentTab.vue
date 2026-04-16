<script setup lang="ts">
import type { ConfigResponse } from '../types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const config = defineModel<ConfigResponse | null>('config')
defineProps<{
  saving: boolean
  success: boolean
}>()

const emit = defineEmits<{
  (e: 'save'): void
}>()
</script>

<template>
  <div>
    <div v-if="!config" class="text-tertiary">No config loaded.</div>

    <div v-else class="space-y-8">
      <!-- Runtime Parameters -->
      <section>
        <h3 class="mb-3 text-sm font-medium text-muted-foreground">Runtime Parameters</h3>
        <div class="grid grid-cols-3 gap-3">
          <div v-for="field of [
            { key: 'max_turns', label: 'Max Turns', min: 1, max: 200, hint: '1 - 200' },
            { key: 'context_window', label: 'Context Window', min: 1000, max: 1000000, hint: '1K - 1M' },
            { key: 'max_output_tokens', label: 'Max Output Tokens', min: 256, max: 100000, hint: '256 - 100K' },
            { key: 'tool_output_max_bytes', label: 'Tool Output (bytes)', min: 1000, max: 1000000, hint: '1K - 1M' },
            { key: 'bash_default_timeout_secs', label: 'Bash Timeout (sec)', min: 1, max: 600, hint: '1 - 600' },
          ]" :key="field.key">
            <label class="mb-1 block text-xs text-tertiary">{{ field.label }}</label>
            <Input
              v-model.number="config[field.key as 'max_turns']"
              type="number"
              :min="field.min"
              :max="field.max"
              class="font-mono text-sm"
            />
            <span class="text-[10px] text-tertiary">{{ field.hint }}</span>
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
        <span v-if="success" class="text-xs text-semantic-green">Saved.</span>
      </div>
    </div>
  </div>
</template>
