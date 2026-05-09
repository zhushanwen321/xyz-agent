<template>
  <div class="model-picker" ref="pickerRef">
    <Button variant="ghost" class="model-picker__trigger" @click="open = !open">
      <span class="model-picker__label">{{ currentLabel }}</span>
      <svg class="model-picker__chevron" :class="{ 'model-picker__chevron--open': open }" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
    </Button>
    <div v-if="open" class="model-picker__dropdown visible">
      <div
        v-for="group in groupedModels"
        :key="group.provider"
        class="model-picker__group"
      >
        <div class="model-picker__group-title">{{ group.provider }}</div>
        <Button
          v-for="m in group.models"
          :key="m.id"
          variant="ghost"
          :class="['model-picker__item', { 'model-picker__item--active': m.id === currentModel }]"
          @click="handleSelect(m.id)"
        >
          {{ m.name }}
        </Button>
      </div>
      <div v-if="groupedModels.length === 0" class="model-picker__empty">
        No models available
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useModel } from '../../composables/useModel'
import { Button } from '../../design-system'

const props = defineProps<{ currentModel: string }>()
const emit = defineEmits<{ select: [modelId: string] }>()

const { models, loadModels } = useModel()
const open = ref(false)
const pickerRef = ref<HTMLElement | null>(null)

onMounted(() => {
  loadModels()
  document.addEventListener('click', onClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside)
})

function onClickOutside(e: MouseEvent) {
  if (pickerRef.value && !pickerRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

/**
 * Format model label as "shortName @ provider".
 * e.g. "claude-sonnet" from anthropic → "sonnet @ anthropic"
 */
const currentLabel = computed(() => {
  const found = models.value.find(m => m.id === props.currentModel || m.id === props.currentModel.split('/').pop())
  if (!found) {
    // Fallback: parse "provider/model-name" from raw id
    const parts = props.currentModel.split('/')
    const rawName = parts.pop() ?? parts[0]
    const rawProvider = parts[0]
    const short = rawName.replace(/^(claude-|gpt-|gemini-)/, '')
    return rawProvider ? `${short} @ ${rawProvider}` : short
  }
  // Strip known prefix (claude-, gpt-, gemini-) from model name
  const shortName = found.name.replace(/^(claude-|gpt-|gemini-)/, '')
  return `${shortName} @ ${found.providerName}`
})

interface ModelGroup {
  provider: string
  models: { id: string; name: string }[]
}

const groupedModels = computed<ModelGroup[]>(() => {
  const map = new Map<string, { id: string; name: string }[]>()
  for (const m of models.value) {
    const key = m.providerName || m.providerId
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push({ id: m.id, name: m.name })
  }
  return Array.from(map.entries()).map(([provider, models]) => ({ provider, models }))
})

function handleSelect(modelId: string) {
  emit('select', modelId)
  open.value = false
}
</script>

<style scoped>
.model-picker {
  position: relative;
}

.model-picker__trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  height: 28px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--fg);
  font-size: 11px;
  font-family: var(--font-mono);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s var(--ease);
}

.model-picker__trigger:hover {
  background: var(--accent-light);
  color: var(--accent);
}

.model-picker__label {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-picker__chevron {
  color: var(--muted);
  transition: transform 0.2s;
}
.model-picker__chevron--open {
  transform: rotate(180deg);
}

.model-picker__dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 260px;
  max-height: 280px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
  z-index: 200;
  overflow-y: auto;
  overflow-x: hidden;
}

.model-picker__group + .model-picker__group {
  border-top: 1px solid var(--border);
}

.model-picker__group-title {
  padding: 6px 12px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.model-picker__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  border: none;
  background: none;
  color: var(--fg);
  font-size: 12px;
  font-family: var(--font-mono);
  text-align: left;
  cursor: pointer;
  transition: background 0.1s var(--ease);
}

.model-picker__item:hover {
  background: var(--accent-light);
}

.model-picker__item--active {
  color: var(--accent);
  font-weight: 600;
}

.model-picker__empty {
  padding: 12px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
</style>
