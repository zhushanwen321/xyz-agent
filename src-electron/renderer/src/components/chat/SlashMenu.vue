<template>
  <div
    v-if="visible && commands.length > 0"
    ref="menuRef"
    class="slash-popup"
  >
    <div class="slash-popup__list">
      <Button
        v-for="(cmd, idx) in commands"
        :key="cmd.name"
        :ref="(el) => { if (idx === activeIndex) activeEl = (el as any)?.$el ?? el }"
        variant="ghost"
        :class="['slash-popup__item', { 'slash-popup__item--active': idx === activeIndex }]"
        @click="handleSelect(cmd)"
        @mouseenter="activeIndex = idx"
      >
        <span
          :class="['slash-popup__tag', cmd.source === 'builtin' ? 'slash-popup__tag--cmd' : 'slash-popup__tag--sk']"
        >{{ cmd.source === 'builtin' ? 'command' : 'skill' }}</span>
        <span class="slash-popup__name">/{{ cmd.name }}</span>
        <span class="slash-popup__desc">{{ cmd.description }}</span>
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
  const inputWrap = target.closest('.chat-input-wrap')
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

<style scoped>
/* 定位在输入框卡片正上方，与设计稿 views_chat.html 一致 */
.slash-popup {
  position: absolute;
  bottom: 100%;
  left: 24px;
  right: 24px;
  margin-bottom: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  max-height: calc(28px * 5);
  overflow-y: auto;
  z-index: 20;
}

.slash-popup__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 10px;
  border: none;
  background: none;
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s var(--ease);
}

.slash-popup__item:hover,
.slash-popup__item--active {
  background: var(--accent-light);
}

/* tag: 元数据层，最弱视觉，小写居中 pill */
.slash-popup__tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.02em;
  border-radius: 3px;
  flex-shrink: 0;
  width: 52px;
  height: 16px;
}

.slash-popup__tag--cmd {
  background: var(--border);
  color: var(--muted);
}

.slash-popup__tag--sk {
  background: var(--accent-light);
  color: var(--accent);
}

/* name: 主信息层，mono + accent */
.slash-popup__name {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono);
  white-space: nowrap;
  color: var(--accent);
  width: 100px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* desc: 次要信息层，muted + 缩短竖线分隔 */
.slash-popup__desc {
  font-size: 11px;
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 8px;
  border-left: 1px solid var(--border);
}
</style>
