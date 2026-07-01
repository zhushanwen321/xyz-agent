<template>
  <!--
    §2b 模型分组 select popover（draft-composer-states §2b）。
    click 触发，所有 provider 平铺同一列表，按分组标题分隔；顶部搜索过滤。
    点选即切换当前 session 模型。
  -->
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        class="h-7 rounded-sm px-2 text-[11.5px] text-subtle transition-colors hover:text-muted"
        title="切换模型"
      >
        <span class="truncate">{{ currentName }}</span>
        <ChevronDown class="ml-px size-[9px] transition-transform" :class="open && 'rotate-180'" />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-[220px] p-0">
      <!-- 搜索 -->
      <div class="border-b border-border p-2">
        <Input v-model="query" placeholder="搜索模型…" class="h-7 bg-surface-2 text-[12px]" />
      </div>

      <!-- 分组列表 -->
      <div class="max-h-[280px] overflow-y-auto py-1">
        <div v-for="group in groups" :key="group.provider" class="py-1">
          <div
            class="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
          >
            {{ group.provider }}
          </div>
          <Button
            v-for="model in group.models"
            :key="model.id"
            variant="ghost"
            class="flex w-full items-center gap-2 rounded-none px-2.5 py-[7px] text-[13px] text-muted hover:bg-surface-hover hover:text-fg"
            :class="isSelected(model.id) && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'"
            @click="onSelect(model.id, group.provider)"
          >
            <span class="flex-1 text-left">{{ model.name }}</span>
            <Check
              class="size-[13px] text-accent opacity-0"
              :class="isSelected(model.id) && 'opacity-100'"
            />
          </Button>
        </div>
        <div
          v-if="groups.length === 0"
          class="px-2.5 py-3 text-center text-[12px] text-subtle"
        >
          无匹配模型
        </div>
      </div>

    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { model as modelApi, type ModelInfo } from '@/api'

const emit = defineEmits<{
  select: [payload: { modelId: string; provider: string }]
}>()

// 接收外部当前选中（Composer 传入），替代写死的 'claude-sonnet-4.5'
const props = defineProps<{
  selected?: string
}>()

const open = ref(false)
const query = ref('')
const models = ref<ModelInfo[]>([])

/**
 * 拆出裸 modelId：selected 可能是 "provider/modelId" 复合串
 * （SessionSummary.modelId / config.defaults.defaultModel 均为此格式），
 * 但 ModelInfo.id 是裸 modelId。匹配列表项时取 `/` 后段。
 */
function bareModelId(v: string): string {
  const i = v.lastIndexOf('/')
  return i >= 0 ? v.slice(i + 1) : v
}

// 订阅模型列表（sendInitialState 推 model.list；组件挂载即得初始列表）
let unsub: (() => void) | null = null
onMounted(() => {
  unsub = modelApi.onModels((list) => { models.value = list })
})
onBeforeUnmount(() => { unsub?.() })

interface ModelGroup {
  providerId: string
  provider: string
  models: ModelInfo[]
}

// 按 provider 分组 + 按 query 过滤（name 包含，大小写不敏感）。空分组不渲染。
const groups = computed<ModelGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map<string, ModelGroup>()
  for (const m of models.value) {
    if (q && !m.name.toLowerCase().includes(q)) continue
    const key = m.providerId
    let g = map.get(key)
    if (!g) {
      g = { providerId: key, provider: m.providerName, models: [] }
      map.set(key, g)
    }
    g.models.push(m)
  }
  return [...map.values()]
})

/** 当前选中值（纯受控：直接用 props，不存本地副本，避免 watch 拉回导致 UI 闪退） */
const selectedValue = computed(() => props.selected ?? '')

const currentName = computed(() => {
  const id = bareModelId(selectedValue.value)
  return models.value.find((m) => m.id === id)?.name ?? id
})

/** 列表项是否选中（兼容复合串 "provider/modelId" 与裸 id 两种来源） */
function isSelected(modelId: string): boolean {
  return bareModelId(selectedValue.value) === modelId
}

function onSelect(id: string, provider: string): void {
  open.value = false
  emit('select', { modelId: id, provider })
}
</script>
