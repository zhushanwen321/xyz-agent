<template>
  <div
    v-if="visible && commands.length > 0"
    ref="menuRef"
    class="absolute bottom-full left-[24px] right-[24px] mb-1 bg-surface border border-border rounded-sm shadow-md max-h-[calc(28px*5)] overflow-y-auto z-20"
  >
    <div>
      <Button
        v-for="(cmd, idx) in commands"
        :key="cmd.name"
        :ref="(el) => { if (idx === activeIndex) activeEl = (el as any)?.$el ?? el }"
        variant="ghost"
        :class="[
          'flex items-center gap-1.5 w-full py-1 px-2.5 border-none bg-transparent text-fg font-body text-xs leading-[1.4] text-left cursor-pointer transition-colors duration-100 ease-ease',
          idx === activeIndex && 'bg-accent-light',
        ]"
        @click="handleSelect(cmd)"
        @mouseenter="activeIndex = idx"
      >
        <span
          :class="[
            'inline-flex items-center justify-center text-[9px] font-medium tracking-[0.02em] rounded-[3px] shrink-0 w-[52px] h-4',
            cmd.source === 'builtin'
              ? 'bg-border text-muted'
              : 'bg-accent-light text-accent',
          ]"
        >{{ cmd.source === 'builtin' ? 'command' : 'skill' }}</span>
    <span class="text-xs font-semibold font-mono whitespace-nowrap text-accent w-[100px] shrink-0 overflow-hidden text-ellipsis">/{{ cmd.name }}</span>
    <span class="text-[11px] text-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap pl-2 border-l border-border">{{ cmd.description }}</span>
    <span
      v-if="cmd.argumentHint"
      class="text-[11px] font-mono text-accent/70 whitespace-nowrap shrink max-w-[40%] overflow-hidden text-ellipsis py-[1px] px-[5px] bg-accent-light rounded-[3px]"
    >{{ cmd.argumentHint }}</span>
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { Button } from '../../design-system'
import type { SlashCommand } from '../../composables/useSlashCommands'

const props = defineProps<{
  visible: boolean
  commands: SlashCommand[]
}>()

const emit = defineEmits<{
  close: []
  select: [cmd: SlashCommand]
}>()

const activeIndex = ref(0)
const activeEl = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

watch(() => props.commands, () => {
  activeIndex.value = 0
})

watch(() => props.visible, (val) => {
  if (val) {
    activeIndex.value = 0
    document.addEventListener('keydown', onKeyDown)
  } else {
    document.removeEventListener('keydown', onKeyDown)
  }
})

function onKeyDown(e: KeyboardEvent) {
  if (!props.visible || props.commands.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % props.commands.length
    scrollActiveIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + props.commands.length) % props.commands.length
    scrollActiveIntoView()
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    const cmd = props.commands[activeIndex.value]
    if (cmd) handleSelect(cmd)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function scrollActiveIntoView() {
  nextTick(() => {
    activeEl.value?.scrollIntoView({ block: 'nearest' })
  })
}

function handleSelect(cmd: SlashCommand) {
  emit('select', cmd)
}

// 点击外部关闭
function onOutsideClick(e: MouseEvent) {
  if (!props.visible) return
  const target = e.target as HTMLElement
  if (menuRef.value?.contains(target)) return
  // 通过检查是否在 chat input 区域内判断点击外部
  // ChatInput 的根 div 使用 data-chat-input 标记
  const inputWrap = target.closest('[data-chat-input]')
  if (!inputWrap) {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onOutsideClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('mousedown', onOutsideClick)
})
</script>

