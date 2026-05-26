<template>
  <div class="relative" ref="pickerRef">
    <Button
      variant="ghost"
      class="inline-flex items-center gap-1 px-2 h-7 border-none rounded-xs bg-transparent text-fg text-[11px] font-mono cursor-pointer whitespace-nowrap transition-all duration-150 ease-ease hover:bg-accent-light hover:text-accent"
      @click="open = !open"
    >
      <span class="text-fg">{{ shortName }}</span>
      <span class="text-border mx-px">@</span>
      <span class="text-muted font-normal">{{ providerName }}</span>
    </Button>
    <div
      v-if="open"
      class="absolute bottom-[calc(100%+6px)] left-0 min-w-[260px] max-h-[280px] bg-surface border border-border rounded-none shadow-md z-[200] overflow-y-auto overflow-x-hidden"
    >
      <div
        v-for="(group, gIdx) in groupedModels"
        :key="group.provider"
        :class="[gIdx > 0 && 'border-t border-border']"
      >
        <div class="py-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">{{ group.provider }}</div>
        <Button
          v-for="m in group.models"
          :key="m.id"
          variant="ghost"
          :class="[
            'flex items-center gap-2 w-full py-[7px] px-3 border-none bg-transparent text-fg text-xs text-left cursor-pointer transition-colors duration-100 ease-ease hover:bg-accent-light',
            m.id === (resolvedModel?.id ?? currentModel) && 'text-accent font-semibold',
          ]"
          @click="handleSelect(m.id)"
        >
          <span
            :class="[
              'w-[5px] h-[5px] rounded-full shrink-0',
              m.id === (resolvedModel?.id ?? currentModel) ? 'bg-accent' : 'bg-border',
            ]"
          ></span>
          <span class="flex-1 font-mono">{{ m.name }}</span>
          <span class="text-[10px] text-muted">{{ group.provider }}</span>
        </Button>
      </div>
      <div v-if="groupedModels.length === 0" class="p-3 text-xs text-muted text-center">
        No models available
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useProviderStore } from '../../stores/provider'
import { useModel } from '../../composables/useModel'
import { Button } from '../../design-system'

const props = defineProps<{ currentModel: string }>()
const emit = defineEmits<{ select: [modelId: string] }>()

const providerStore = useProviderStore()
const open = ref(false)
const pickerRef = ref<HTMLElement | null>(null)

onMounted(() => {
  const { listModels } = useModel()
  listModels()
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
const models = computed(() => providerStore.models)

const resolvedModel = computed(() => {
  if (!props.currentModel) return models.value[0]
  return models.value.find(m => m.id === props.currentModel || m.id === props.currentModel.split('/').pop()) ?? models.value[0]
})

const shortName = computed(() => {
  const found = resolvedModel.value
  if (!found) {
    const rawName = props.currentModel.split('/').pop() ?? props.currentModel
    return rawName.replace(/^(claude-|gpt-|gemini-)/, '')
  }
  return found.name.replace(/^(claude-|gpt-|gemini-)/, '')
})

const providerName = computed(() => {
  const found = resolvedModel.value
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
  const enabledProviderIds = new Set(
    providerStore.providers
      .filter(p => p.enabled !== false)
      .map(p => p.id)
  )
  const map = new Map<string, { id: string; name: string }[]>()
  for (const m of models.value) {
    // 只显示已启用 provider 的模型
    if (!enabledProviderIds.has(m.providerId)) continue
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
