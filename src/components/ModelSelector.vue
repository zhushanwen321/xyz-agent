<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useModelManager } from '../composables/useModelManager'
import { Button } from '@/components/ui/button'
import type { ModelInfo, ModelTier } from '../types'

const props = defineProps<{
  currentModel: string
}>()

const emit = defineEmits<{
  (e: 'select', modelRef: string): void
}>()

const { models, load } = useModelManager()
const open = ref(false)

const tierLabel: Record<ModelTier, string> = {
  balanced: '均衡',
  reasoning: '推理',
  fast: '快速',
}

const tierColor: Record<ModelTier, string> = {
  balanced: 'text-semantic-green',
  reasoning: 'text-semantic-yellow',
  fast: 'text-semantic-blue',
}

// 按 provider 分组
const groupedByProvider = computed(() => {
  const map = new Map<string, ModelInfo[]>()
  for (const m of models.value) {
    const list = map.get(m.provider_name) ?? []
    list.push(m)
    map.set(m.provider_name, list)
  }
  return map
})

// 当前模型的显示信息
const currentInfo = computed(() => {
  const m = models.value.find((m) => m.model_ref === props.currentModel)
  if (!m) return { name: props.currentModel, tierLabel: '' }
  return {
    name: m.alias ?? m.model_id,
    tierLabel: tierLabel[m.tier],
    tierColor: tierColor[m.tier],
  }
})

function toggle() {
  open.value = !open.value
  if (open.value && models.value.length === 0) {
    load()
  }
}

function select(modelRef: string) {
  emit('select', modelRef)
  open.value = false
}

function handleClickOutside(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('.model-selector')) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  load()
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="model-selector relative">
    <Button
      variant="ghost"
      class="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[11px] transition-colors hover:bg-inset"
      :class="open ? 'bg-inset text-foreground' : 'text-tertiary'"
      @click="toggle"
    >
      <span>{{ currentInfo.name }}</span>
      <span v-if="currentInfo.tierLabel" :class="currentInfo.tierColor" class="text-[10px]">
        [{{ currentInfo.tierLabel }}]
      </span>
      <svg
        class="h-3 w-3 transition-transform"
        :class="open ? 'rotate-180' : ''"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      >
        <path d="M3 4.5L6 7.5L9 4.5" />
      </svg>
    </Button>

    <!-- 下拉列表 -->
    <div
      v-if="open"
      class="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border-default bg-elevated py-1 shadow-lg"
    >
      <template v-for="[provider, providerModels] of groupedByProvider" :key="provider">
        <div class="px-3 pt-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-tertiary">
          {{ provider }}
        </div>
        <Button
          v-for="m in providerModels"
          :key="m.model_ref"
          variant="ghost"
          size="sm"
          class="flex w-full items-center justify-between px-3 py-1 font-mono text-[11px] hover:bg-inset"
          :class="m.model_ref === currentModel ? 'text-semantic-green' : 'text-foreground'"
          @click="select(m.model_ref)"
        >
          <span class="truncate">{{ m.alias ?? m.model_id }}</span>
          <span :class="tierColor[m.tier]" class="ml-2 shrink-0 text-[10px]">
            [{{ tierLabel[m.tier] }}]
          </span>
        </Button>
      </template>
    </div>
  </div>
</template>
