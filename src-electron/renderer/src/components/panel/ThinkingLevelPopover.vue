<template>
  <!--
    思考等级 popover（draft-composer-states §2c）。
    click 触发，6 级：off / low / medium / high / xhigh / max（默认 max）。
    触发器与列表项点随等级染色（紫相递进），max 整颗紫底白字 + 外发光（最强权重）。
  -->
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        class="h-7 rounded-sm px-2 text-[11.5px] transition-colors"
        :class="thinkTriggerClass"
        :style="thinkTriggerStyle"
        title="思考等级"
      >
        <span>思考 {{ currentLabel }}</span>
        <ChevronDown
          class="size-3 transition-transform duration-200"
          :class="open && 'rotate-180'"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-[260px] p-0">
      <!-- head -->
      <div
        class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
      >
        <span>思考等级</span>
        <span>sonnet-4.5</span>
      </div>
      <!-- 6 级列表 -->
      <Button
        v-for="opt in MOCK_THINKING_LEVELS"
        :key="opt.level"
        variant="ghost"
        class="flex w-full items-center gap-2.5 rounded-none px-2.5 py-2 text-[13px] text-muted hover:bg-surface-hover"
        :class="[
          level === opt.level && 'bg-[rgba(167,139,250,0.1)]',
          !opt.available && 'cursor-not-allowed opacity-50',
        ]"
        @click="onSelect(opt)"
      >
        <span
          class="size-[7px] shrink-0 rounded-full"
          :class="dotClass[opt.level]"
          :style="dotStyle(opt.level)"
        />
        <span class="flex-1" :class="nameClass[opt.level]">{{ opt.label }} {{ opt.en }}</span>
        <Check
          class="size-[13px] text-reasoning transition-opacity"
          :class="level === opt.level ? 'opacity-100' : 'opacity-0'"
        />
      </Button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue'
import { computed, ref } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  MOCK_THINKING_LEVELS,
  type MockThinkingLevel,
  type ThinkingLevel,
} from '@/api/mock/composer-data'

const emit = defineEmits<{
  select: [level: ThinkingLevel]
}>()

const open = ref(false)
// 默认 max：开 composer 即最高思考强度（紫底按钮常驻提示）
const level = ref<ThinkingLevel>('max')

const currentLabel = computed(
  () => MOCK_THINKING_LEVELS.find((l) => l.level === level.value)?.label ?? '思考',
)

// 触发器文字配色随等级（draft .c-text.think[data-lvl] 已定稿）
// off/low 灰 → medium 柔紫 → high/xhigh 实色紫 → max 白字（底色见 thinkTriggerStyle）
const thinkTriggerClass = computed(() => {
  switch (level.value) {
    case 'medium':
      return 'text-[#b9a5e6]'
    case 'high':
    case 'xhigh':
      return 'text-reasoning'
    case 'max':
      return 'text-white'
    default:
      return 'text-subtle/80 hover:text-muted'
  }
})

// xhigh 文字柔光 + max 紫底外发光用 :style：
// Tailwind v3 无 text-shadow 工具类；max 的 box-shadow 与底色同源紫，集中表达更直观
const thinkTriggerStyle = computed<CSSProperties>(() => {
  switch (level.value) {
    case 'xhigh':
      return { textShadow: '0 0 8px rgba(167,139,250,0.5)' }
    case 'max':
      return {
        backgroundColor: 'rgba(167,139,250,0.85)',
        boxShadow: '0 0 12px rgba(167,139,250,0.4)',
      }
    default:
      return {}
  }
})

// 列表项小点配色（off→max 强度递进，draft .th-dot[data-lvl]）
const dotClass: Record<ThinkingLevel, string> = {
  off: 'bg-subtle',
  low: 'bg-muted',
  medium: 'bg-[rgba(167,139,250,0.55)]',
  high: 'bg-reasoning',
  xhigh: 'bg-reasoning',
  max: 'bg-reasoning',
}

// xhigh/max 光环（box-shadow ring），同样用 :style
function dotStyle(lvl: ThinkingLevel): CSSProperties {
  if (lvl === 'xhigh') return { boxShadow: '0 0 0 3px rgba(167,139,250,0.22)' }
  if (lvl === 'max') return { boxShadow: '0 0 0 4px rgba(167,139,250,0.32)' }
  return {}
}

// 名称配色：high/xhigh 紫，max 浅紫加粗
const nameClass: Record<ThinkingLevel, string> = {
  off: '',
  low: '',
  medium: '',
  high: 'text-reasoning',
  xhigh: 'text-reasoning',
  max: 'text-[#c9b6f5] font-semibold',
}

function onSelect(opt: MockThinkingLevel): void {
  if (!opt.available) return
  level.value = opt.level
  emit('select', opt.level)
  open.value = false
}
</script>
