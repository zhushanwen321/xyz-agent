<template>
  <div class="model-picker" ref="pickerRef">
    <button class="model-picker__trigger" @click="open = !open">
      <span class="model-picker__label">{{ currentLabel }}</span>
      <span class="model-picker__chevron">{{ open ? '▴' : '▾' }}</span>
    </button>
    <div v-if="open" class="model-picker__dropdown">
      <div
        v-for="group in groupedModels"
        :key="group.provider"
        class="model-picker__group"
      >
        <div class="model-picker__group-title">{{ group.provider }}</div>
        <button
          v-for="m in group.models"
          :key="m.id"
          :class="['model-picker__item', { 'model-picker__item--active': m.id === currentModel }]"
          @click="handleSelect(m.id)"
        >
          {{ m.name }}
        </button>
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

const currentLabel = computed(() => {
  const found = models.value.find(m => m.id === props.currentModel)
  return found ? found.name : props.currentModel
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
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-base);
  color: var(--color-text-primary);
  font-size: 12px;
  font-family: var(--font-body);
  cursor: pointer;
  white-space: nowrap;
}

.model-picker__trigger:hover {
  border-color: var(--color-accent);
}

.model-picker__label {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-picker__chevron {
  font-size: 10px;
  color: var(--color-text-muted);
}

.model-picker__dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 100;
  padding: 4px 0;
}

.model-picker__group + .model-picker__group {
  border-top: 1px solid var(--color-border);
  margin-top: 4px;
  padding-top: 4px;
}

.model-picker__group-title {
  padding: 4px 12px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

.model-picker__item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--color-text-primary);
  font-size: 13px;
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
}

.model-picker__item:hover {
  background: var(--color-accent-light);
}

.model-picker__item--active {
  font-weight: 600;
  color: var(--color-accent);
}

.model-picker__empty {
  padding: 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: center;
}
</style>
