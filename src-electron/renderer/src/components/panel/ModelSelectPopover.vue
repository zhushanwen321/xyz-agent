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
            <!-- providerColor 是动态 inline style，唯一允许的 style 属性 -->
            <span class="size-1.5 rounded-full" :style="{ background: group.color }" />
            {{ group.provider }}
          </div>
          <Button
            v-for="model in group.models"
            :key="model.id"
            variant="ghost"
            class="flex w-full items-center gap-2 rounded-none px-2.5 py-[7px] text-[13px] text-muted hover:bg-surface-hover hover:text-fg"
            :class="model.id === selected && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'"
            @click="onSelect(model.id)"
          >
            <span class="flex-1 text-left">{{ model.name }}</span>
            <span
              v-if="model.tag"
              class="rounded-full bg-surface-2 px-1.5 py-[3px] font-mono text-[9px] uppercase tracking-[0.04em] text-subtle"
              :class="model.id === selected && 'bg-accent-soft text-accent'"
            >{{ model.tag }}</span>
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

      <!-- foot -->
      <div
        class="flex justify-between border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-subtle"
      >
        <span>选中即用于当前 session</span>
        <kbd
          class="rounded-sm border border-border bg-surface px-1 py-px text-subtle"
        >click</kbd>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MOCK_MODELS, type MockModel } from '@/api/mock/composer-data'

const emit = defineEmits<{
  select: [modelId: string]
}>()

const open = ref(false)
const selected = ref('claude-sonnet-4.5')
const query = ref('')

interface ModelGroup {
  provider: string
  color: string
  models: MockModel[]
}

// 按 provider 分组 + 按 query 过滤（name 包含，大小写不敏感）。空分组不渲染。
const groups = computed<ModelGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map<string, ModelGroup>()
  for (const m of MOCK_MODELS) {
    if (q && !m.name.toLowerCase().includes(q)) continue
    let g = map.get(m.provider)
    if (!g) {
      g = { provider: m.provider, color: m.providerColor, models: [] }
      map.set(m.provider, g)
    }
    g.models.push(m)
  }
  return [...map.values()]
})

const currentName = computed(
  () => MOCK_MODELS.find((m) => m.id === selected.value)?.name ?? selected.value,
)

function onSelect(id: string): void {
  selected.value = id
  open.value = false
  emit('select', id)
}
</script>
