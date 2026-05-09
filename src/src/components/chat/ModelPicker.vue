<template>
  <div class="model-picker" ref="pickerRef">
    <Button variant="ghost" class="model-picker__trigger" @click="open = !open">
      <span class="model-picker__name">{{ shortName }}</span>
      <span class="model-picker__sep">@</span>
      <span class="model-picker__provider">{{ providerName }}</span>
    </Button>
    <div v-if="open" class="model-picker__dropdown">
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
          <span class="model-picker__item-dot"></span>
          <span class="model-picker__item-name">{{ m.name }}</span>
          <span class="model-picker__item-provider">{{ group.provider }}</span>
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

/** Format model name: strip known prefix */
const shortName = computed(() => {
  const found = models.value.find(m => m.id === props.currentModel || m.id === props.currentModel.split('/').pop())
  if (!found) {
    const rawName = props.currentModel.split('/').pop() ?? props.currentModel
    return rawName.replace(/^(claude-|gpt-|gemini-)/, '')
  }
  return found.name.replace(/^(claude-|gpt-|gemini-)/, '')
})

const providerName = computed(() => {
  const found = models.value.find(m => m.id === props.currentModel || m.id === props.currentModel.split('/').pop())
  if (!found) {
    const parts = props.currentModel.split('/')
    return parts.length > 1 ? parts[0] : ''
  }
  return found.providerName || found.providerId
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

.model-picker__name {
  color: var(--fg);
}

.model-picker__sep {
  color: var(--border);
  margin: 0 1px;
}

.model-picker__provider {
  color: var(--muted);
  font-weight: 400;
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

.model-picker__item--active .model-picker__item-dot {
  background: var(--accent);
}

.model-picker__item-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--border);
  flex-shrink: 0;
}

.model-picker__item-name {
  flex: 1;
  font-family: var(--font-mono);
}

.model-picker__item-provider {
  font-size: 10px;
  color: var(--muted);
}

.model-picker__empty {
  padding: 12px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
</style>
