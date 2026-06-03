<template>
  <div
    v-if="visible && mergedCommands.length > 0"
    ref="menuRef"
    class="absolute top-[28px] left-[24px] right-[24px] bg-surface border border-border rounded-none shadow-md max-h-[calc(28px*5)] overflow-y-auto z-20"
  >
    <div>
      <Button
        v-for="(cmd, idx) in mergedCommands"
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
            'inline-flex items-center justify-center text-[9px] font-medium tracking-[0.02em] rounded-sm shrink-0 w-[52px] h-4',
            cmd.source === 'builtin'
              ? 'bg-border text-muted'
              : cmd.source === 'skill'
              ? 'bg-accent-light text-accent'
              : cmd.source === 'native'
              ? 'bg-[var(--section-bg)] text-accent'
              : cmd.source === 'extension'
              ? 'bg-[var(--section-bg)] text-muted'
              : cmd.source === 'plugin'
              ? 'bg-[var(--warning-light)] text-[var(--warning)]'
              : 'bg-agent-light text-agent',
          ]"
        >{{ cmd.source === 'builtin' ? 'command' : cmd.source === 'skill' ? 'skill' : cmd.source === 'native' ? 'native' : cmd.source === 'extension' ? 'ext' : cmd.source === 'plugin' ? 'plugin' : 'agent' }}</span>
    <span class="text-xs font-semibold font-mono whitespace-nowrap text-accent min-w-[120px] max-w-[40%] shrink-0 overflow-hidden text-ellipsis">/{{ displayName(cmd) }}</span>
    <!-- 不加 :title，避免 hover 时与我的 hover-tip 重复出现两个 tooltip -->
    <span class="text-[11px] text-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap pl-2 border-l border-border">{{ cmd.description }}</span>
    <span
      v-if="cmd.argumentHint"
      class="text-[11px] font-mono text-accent/70 whitespace-nowrap shrink max-w-[40%] overflow-hidden text-ellipsis py-[1px] px-[5px] bg-accent-light rounded-sm"
    >{{ cmd.argumentHint }}</span>
      </Button>
    </div>
  </div>

  <!-- Hover tooltip: Teleport 到 body + position: fixed，脱离所有 overflow 裁剪 -->
  <Teleport to="body">
    <div
      v-if="hoverTipFor"
      class="hover-tip"
      :style="{ top: tipPos.top + 'px', left: tipPos.left + 'px' }"
      @mouseenter="onTipEnter"
      @mouseleave="onTipLeave"
    >
      <div class="hover-tip__name">/{{ displayName(hoverTipFor) }}</div>
      <div class="hover-tip__desc">{{ hoverTipFor.description }}</div>
      <div v-if="hoverTipFor.argumentHint" class="hover-tip__arg">
        <span class="hover-tip__arg-label">参数:</span>
        <span class="hover-tip__arg-value">{{ hoverTipFor.argumentHint }}</span>
      </div>
      <div class="hover-tip__arrow" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { Button } from '../../design-system'
import { usePluginStore } from '../../stores/plugin'
import type { SlashCommand } from '../../composables/useSlashCommands'

const props = defineProps<{
  visible: boolean
  commands: SlashCommand[]
}>()

const emit = defineEmits<{
  close: []
  select: [cmd: SlashCommand]
}>()

const pluginStore = usePluginStore()

/** Map plugin store's slash commands into SlashCommand format */
const pluginCommands = computed<SlashCommand[]>(() =>
  pluginStore.allSlashCommands.map(cmd => ({
    name: cmd.name,
    description: `${cmd.description} (Plugin: ${pluginStore.pluginById(cmd.pluginId)?.displayName ?? cmd.pluginId})`,
    source: 'plugin' as const,
    action: { type: 'plugin' as const, pluginId: cmd.pluginId, commandName: cmd.name },
  })),
)

/** Merge existing commands with plugin commands */
const mergedCommands = computed(() => [...props.commands, ...pluginCommands.value])

const activeIndex = ref(0)
const activeEl = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

// Hover tooltip 状态：Teleport + position: fixed
const HOVER_CLOSE_DELAY_MS = 120
const SCROLL_CAPTURE_PHASE = true
const CENTER_DIVISOR = 2
const hoveredIdx = ref<number | null>(null)
const tipPos = ref({ top: 0, left: 0 })
let closeTimer: ReturnType<typeof setTimeout> | null = null

// 优先用 hover idx，否则跟随键盘 activeIndex
const hoverTipFor = computed<SlashCommand | null>(() => {
  const idx = hoveredIdx.value ?? activeIndex.value
  return mergedCommands.value[idx] ?? null
})

watch(() => props.commands, () => {
  activeIndex.value = 0
})

watch(() => [props.visible, pluginCommands.value.length] as const, ([visible]) => {
  if (visible) {
    activeIndex.value = 0
    document.addEventListener('keydown', onKeyDown)
  } else {
    document.removeEventListener('keydown', onKeyDown)
  }
})

// Hover 事件 handler（被 template @mouseenter/@mouseleave 引用，eslint 看不到故忽略检测）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const onItemEnter = (idx: number) => {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  hoveredIdx.value = idx
  nextTick(updateTipPos)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const onItemLeave = () => {
  // 缓冲时间，让鼠标有时间移到 tooltip 上不闪
  closeTimer = setTimeout(() => {
    hoveredIdx.value = null
  }, HOVER_CLOSE_DELAY_MS)
}

const onTipEnter = () => {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

const onTipLeave = () => {
  hoveredIdx.value = null
}

function updateTipPos() {
  if (!hoverTipFor.value || !menuRef.value) return
  const items = menuRef.value.querySelectorAll<HTMLElement>('[class*="cursor-pointer"]')
  const idx = hoveredIdx.value ?? activeIndex.value
  const item = items[idx]
  if (!item) return
  const rect = item.getBoundingClientRect()
  // transform: translate(-50%, -100%) → tooltip 底部对齐 rect.top, tooltip 中心对齐 item 中心
  tipPos.value = {
    top: rect.top,
    left: rect.left + rect.width / CENTER_DIVISOR,
  }
}

function onWindowChange() {
  if (hoverTipFor.value) updateTipPos()
}

function onKeyDown(e: KeyboardEvent) {
  if (!props.visible || mergedCommands.value.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % mergedCommands.value.length
    scrollActiveIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + mergedCommands.value.length) % mergedCommands.value.length
    scrollActiveIntoView()
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    const cmd = mergedCommands.value[activeIndex.value]
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
  if (cmd.action.type === 'plugin') {
    pluginStore.executeCommand(cmd.action.pluginId, cmd.action.commandName)
    emit('close')
  } else {
    emit('select', cmd)
  }
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

function displayName(cmd: SlashCommand): string {
  // Agent 命令名有 `agent:` 前缀，显示时去掉
  // Extension 命令名可能有 `skill:` 前缀，显示时去掉
  if (cmd.source === 'agent') return cmd.name.replace(/^agent:/, '')
  if (cmd.source === 'extension') return cmd.name.replace(/^skill:/, '')
  return cmd.name
}

onMounted(() => {
  document.addEventListener('mousedown', onOutsideClick)
  window.addEventListener('resize', onWindowChange)
  window.addEventListener('scroll', onWindowChange, SCROLL_CAPTURE_PHASE)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('mousedown', onOutsideClick)
  window.removeEventListener('resize', onWindowChange)
  window.removeEventListener('scroll', onWindowChange, SCROLL_CAPTURE_PHASE)
  if (closeTimer) clearTimeout(closeTimer)
})

// popup 关闭时清掉 hover
watch(() => props.visible, (v) => {
  if (!v) {
    hoveredIdx.value = null
    if (closeTimer) clearTimeout(closeTimer)
  }
})

// 键盘切换 activeIndex 时，hover 没设置则更新位置
watch(activeIndex, () => {
  if (hoveredIdx.value === null) {
    nextTick(updateTipPos)
  }
})

// tooltip 第一次出现时 / popup visible 变 true 时也需要更新位置
watch(hoverTipFor, (v) => {
  if (v) nextTick(updateTipPos)
}, { immediate: true })
</script>

<style scoped>
/* Hover tooltip — Teleport 到 body + position: fixed，脱离所有 overflow/transform 裁剪 */
.hover-tip {
  position: fixed;
  z-index: 50;
  min-width: 240px;
  max-width: 380px;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-left-width: 3px;
  border-radius: 1px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
  padding: 10px 12px;
  /* 中心 + 浮在 item 顶部上方：bottom 对齐到 inline top（item.top），center 对齐 item 中心 */
  transform: translate(-50%, -100%);
  pointer-events: auto;
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
  word-break: break-word;
}
.hover-tip__name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 4px;
}
.hover-tip__desc {
  color: var(--fg);
}
.hover-tip__arg {
  margin-top: 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.hover-tip__arg-label { color: var(--muted); }
.hover-tip__arg-value {
  color: var(--accent);
  background: var(--accent-light);
  padding: 1px 5px;
  border-radius: 1px;
}
.hover-tip__arrow {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 0; height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 5px solid var(--accent);
}
</style>

