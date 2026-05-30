<script setup lang="ts">
import { ref, watch } from 'vue'
import ToggleSwitch from './shared/ToggleSwitch.vue'
import { Input, Button } from '../../design-system'

const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

interface LevelState {
  level: string
  enabled: boolean
  apiValue: string
}

const props = defineProps<{
  modelValue: Record<string, string | null> | undefined
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, string | null> | undefined]
}>()

const levels = ref<LevelState[]>([])

function initLevels(map: Record<string, string | null> | undefined): void {
  levels.value = ALL_THINKING_LEVELS.map((level) => {
    if (map === undefined || !(level in map)) {
      return { level, enabled: true, apiValue: '' }
    }
    const val = map[level]
    if (val === null) {
      return { level, enabled: false, apiValue: '' }
    }
    return { level, enabled: true, apiValue: val }
  })
}

function buildMap(): Record<string, string | null> | undefined {
  const map: Record<string, string | null> = {}
  let hasNonTrivial = false

  for (const item of levels.value) {
    if (!item.enabled) {
      map[item.level] = null
      hasNonTrivial = true
    } else if (item.apiValue) {
      map[item.level] = item.apiValue
      hasNonTrivial = true
    }
    // enabled=true + empty apiValue → omit (passthrough)
  }

  return hasNonTrivial ? map : undefined
}

let selfEmitting = false

function onToggle(idx: number): void {
  levels.value[idx].enabled = !levels.value[idx].enabled
  selfEmitting = true
  emit('update:modelValue', buildMap())
  selfEmitting = false
}

function onInput(idx: number, value: string): void {
  levels.value[idx].apiValue = value
  selfEmitting = true
  emit('update:modelValue', buildMap())
  selfEmitting = false
}

function applyPreset(name: 'deepseek' | 'all-on' | 'generic'): void {
  switch (name) {
    case 'deepseek':
      levels.value.forEach((item) => {
        if (item.level === 'off' || item.level === 'minimal' || item.level === 'low' || item.level === 'medium') {
          item.enabled = false
          item.apiValue = ''
        } else if (item.level === 'high') {
          item.enabled = true
          item.apiValue = 'high'
        } else if (item.level === 'xhigh') {
          item.enabled = true
          item.apiValue = 'max'
        } else if (item.level === 'max') {
          item.enabled = true
          item.apiValue = 'max'
        }
      })
      break
    case 'all-on':
      levels.value.forEach((item) => {
        item.enabled = true
        item.apiValue = ''
      })
      break
    case 'generic':
      levels.value.forEach((item) => {
        item.enabled = true
        if (item.level === 'high') {
          item.apiValue = 'high'
        } else if (item.level === 'xhigh') {
          item.apiValue = 'max'
        } else if (item.level === 'max') {
          item.apiValue = 'max'
        } else {
          item.apiValue = ''
        }
      })
      break
  }
  selfEmitting = true
  emit('update:modelValue', buildMap())
  selfEmitting = false
}

initLevels(props.modelValue)

watch(() => props.modelValue, (newVal) => {
  if (!selfEmitting) initLevels(newVal)
})
</script>

<template>
  <div class="pl-6 py-2 space-y-1">
    <div
      v-for="(item, idx) in levels"
      :key="item.level"
      class="flex items-center gap-3 h-7"
    >
      <ToggleSwitch
        :model-value="item.enabled"
        @update:model-value="onToggle(idx)"
      />
      <span
        class="text-[12px] w-16 shrink-0"
        :class="item.enabled ? 'text-foreground' : 'text-muted'"
      >
        {{ item.level }}
      </span>
      <Input
        :model-value="item.apiValue"
        :disabled="!item.enabled"
        placeholder="—"
        class="flex-1 max-w-[160px]"
        @update:model-value="onInput(idx, $event as string)"
      />
    </div>
    <div class="flex gap-2 pt-2">
      <Button
        variant="outline"
        size="sm"
        class="text-[11px]"
        @click="applyPreset('deepseek')"
      >
        DeepSeek
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="text-[11px]"
        @click="applyPreset('all-on')"
      >
        全开（透传）
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="text-[11px]"
        @click="applyPreset('generic')"
      >
        通用映射
      </Button>
    </div>
  </div>
</template>
