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
        class="h-7 rounded-sm px-2 text-[11.5px] text-subtle/80 hover:text-muted"
        title="切换模型"
      >
        <span class="truncate">{{ currentName }}</span>
        <ChevronDown class="size-[9px] transition-transform" :class="open && 'rotate-180'" />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-[260px] p-0">
      <!-- 搜索 -->
      <div class="border-b border-border p-2">
        <Input v-model="query" placeholder="搜索模型…" class="h-7 bg-surface-2 text-[12px]" />
      </div>

      <!-- 分组列表 -->
      <div class="max-h-[280px] overflow-y-auto py-1">
        <div v-for="group in groups" :key="group.provider" class="py-1">
          <div
            class="flex items-center gap-1.5 px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
          >
            <!-- provider 颜色是纯 UI 关注点（runtime 不下发），按 providerId 本地映射；唯一允许的 inline style -->
            <span class="size-1.5 rounded-full" :style="{ background: group.color }" />
            {{ group.provider }}
          </div>
          <Button
            v-for="model in group.models"
            :key="model.id"
            variant="ghost"
            class="flex w-full items-center gap-2 rounded-none px-2.5 py-[7px] text-[13px] text-muted hover:bg-surface-hover hover:text-fg"
            :class="model.id === selected && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'"
            @click="onSelect(model.id, group.provider)"
          >
            <span class="flex-1 text-left">{{ model.name }}</span>
            <Check
              class="size-[13px] text-accent opacity-0"
              :class="model.id === selected && 'opacity-100'"
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
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
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
const selected = ref(props.selected ?? '')
const query = ref('')
const models = ref<ModelInfo[]>([])

// provider → 品牌色映射（纯 UI 关注点：runtime ModelInfo 不下发颜色）。
// 未命中的 provider 用中性灰兜底，保证 UI 不塌陷。
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  openai: '#10a37f',
  google: '#4285f4',
}
const DEFAULT_PROVIDER_COLOR = '#94a3b8'

function providerColor(providerId: string): string {
  return PROVIDER_COLORS[providerId.toLowerCase()] ?? DEFAULT_PROVIDER_COLOR
}

// 外部 selected 变化时同步本地（单向：父 → 子）
watch(() => props.selected, (v) => { if (v) selected.value = v })

// 订阅模型列表（sendInitialState 推 model.list；组件挂载即得初始列表）
let unsub: (() => void) | null = null
onMounted(() => {
  unsub = modelApi.onModels((list) => { models.value = list })
})
onBeforeUnmount(() => { unsub?.() })

interface ModelGroup {
  providerId: string
  provider: string
  color: string
  models: ModelInfo[]
}

// 按 provider 分组 + 按 query 过滤（name 包含，大小写不敏感）。空分组不渲染。
// shared.ModelInfo 用 providerId（分组键）/ providerName（展示），颜色本地映射。
const groups = computed<ModelGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map<string, ModelGroup>()
  for (const m of models.value) {
    if (q && !m.name.toLowerCase().includes(q)) continue
    const key = m.providerId
    let g = map.get(key)
    if (!g) {
      g = { providerId: key, provider: m.providerName, color: providerColor(key), models: [] }
      map.set(key, g)
    }
    g.models.push(m)
  }
  return [...map.values()]
})

const currentName = computed(
  () => models.value.find((m) => m.id === selected.value)?.name ?? selected.value,
)

function onSelect(id: string, provider: string): void {
  selected.value = id
  open.value = false
  emit('select', { modelId: id, provider })
}
</script>
