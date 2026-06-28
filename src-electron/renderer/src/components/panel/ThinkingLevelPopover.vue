<template>
  <!--
    思考等级 popover（draft-composer-states §2c）。
    click 触发，6 级：off / low / medium / high / xhigh / max（默认 max）。
    触发器与列表均中性配色（与上下文容量 / 模型触发器同款 text-subtle），仅选中态走 accent，
    不再按等级染紫相（去色要求）。等级强度靠 popover 内 off→max 的语义表达。
  -->
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        class="h-7 gap-1 rounded-sm px-2 text-[11.5px] text-subtle transition-colors hover:text-muted"
        title="思考等级"
      >
        <Brain class="size-3 shrink-0" />
        <span>{{ currentLabel }}</span>
        <ChevronDown
          class="ml-px size-[9px] transition-transform duration-200"
          :class="open && 'rotate-180'"
        />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-[180px] p-0">
      <!-- head -->
      <div
        class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle"
      >
        <span>思考等级</span>
      </div>
      <!-- 6 级列表 -->
      <Button
        v-for="opt in THINKING_LEVELS"
        :key="opt.level"
        variant="ghost"
        class="flex w-full items-center gap-2 rounded-none px-2.5 py-2 text-[13px] text-muted hover:bg-surface-hover hover:text-fg"
        :class="[
          level === opt.level && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
          !opt.available && 'cursor-not-allowed opacity-50',
        ]"
        @click="onSelect(opt)"
      >
        <span
          class="size-[7px] shrink-0 rounded-full"
          :class="level === opt.level ? 'bg-accent' : 'bg-subtle'"
        />
        <span class="flex-1 text-left">{{ opt.label }} {{ opt.en }}</span>
        <Check
          class="size-[13px] text-accent transition-opacity"
          :class="level === opt.level ? 'opacity-100' : 'opacity-0'"
        />
      </Button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ChevronDown, Brain } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { THINKING_LEVELS, type ThinkingLevelOption, type ThinkingLevel } from './thinking-levels'

const emit = defineEmits<{
  select: [level: ThinkingLevel]
}>()

// 外部当前等级（Composer 从 SessionSummary.thinkingLevel 透传，string 类型）；
// 值合法时映射到 ThinkingLevel，否则 fallback max。无则默认 max。
const props = defineProps<{
  level?: string
}>()

const open = ref(false)
/** 传入的 level 是否为合法 ThinkingLevel 枚举值 */
function isValidLevel(v: string): v is ThinkingLevel {
  return THINKING_LEVELS.some((opt) => opt.level === v)
}
// 本地态初始化自 prop（合法则用，否则 fallback max）；prop 变化时同步
const level = ref<ThinkingLevel>(
  props.level && isValidLevel(props.level) ? props.level : 'max',
)
watch(() => props.level, (v) => {
  if (v && isValidLevel(v)) level.value = v
})

const currentLabel = computed(
  () => THINKING_LEVELS.find((l) => l.level === level.value)?.label ?? '思考',
)

function onSelect(opt: ThinkingLevelOption): void {
  if (!opt.available) return
  level.value = opt.level
  emit('select', opt.level)
  open.value = false
}
</script>
