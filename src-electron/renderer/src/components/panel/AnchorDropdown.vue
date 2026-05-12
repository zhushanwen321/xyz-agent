<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Button } from '../../design-system'

interface AnchorOption {
  id: string
  label: string
  color?: string
}

const props = defineProps<{
  options: AnchorOption[]
  currentId: string
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const open = ref(false)
const anchorRef = ref<HTMLElement | null>(null)

const currentOpt = computed(() =>
  props.options.find(o => o.id === props.currentId)
)
const currentLabel = computed(() => currentOpt.value?.label ?? '')
const currentColor = computed(() => currentOpt.value?.color ?? 'var(--success)')

function toggle() {
  open.value = !open.value
}

function pick(id: string) {
  emit('select', id)
  open.value = false
}

function onClickOutside(e: MouseEvent) {
  if (anchorRef.value && !anchorRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', onClickOutside))
onBeforeUnmount(() => document.removeEventListener('click', onClickOutside))
</script>

<template>
  <div :class="['flex items-center gap-1.5 px-2.5 py-[3px] rounded-sm cursor-pointer text-fg font-semibold text-xs transition-colors duration-150 ease-ease relative select-none hover:bg-accent-light', { 'bg-accent-light': open }]" ref="anchorRef">
    <Button variant="ghost" class="flex items-center gap-1.5 bg-transparent border-none p-0 [font:inherit] [color:inherit] cursor-[inherit] hover:bg-transparent hover:text-inherit !rounded-none" @click.stop="toggle">
      <span class="w-1.5 h-1.5 rounded-full shrink-0" :style="{ background: currentColor }"></span>
      <span class="leading-none">{{ currentLabel }}</span>
      <span :class="['text-[9px] text-muted ml-0.5 transition-transform duration-150 ease-ease', { 'rotate-180': open }]">&#9662;</span>
    </Button>
    <div v-if="open" class="absolute top-full left-0 mt-1 bg-surface border border-border rounded-sm shadow-md min-w-[220px] z-30 overflow-hidden">
      <div
        v-for="opt in options"
        :key="opt.id"
        :class="['flex items-center gap-2 px-3 py-[7px] text-xs cursor-pointer transition-colors duration-100 ease-ease text-fg font-normal hover:bg-accent-light', { 'font-semibold text-accent': opt.id === currentId }]"
        @click="pick(opt.id)"
      >
        <span class="w-1.5 h-1.5 rounded-full shrink-0" :style="{ background: opt.color || 'var(--success)' }"></span>
        {{ opt.label }}
      </div>
    </div>
  </div>
</template>

