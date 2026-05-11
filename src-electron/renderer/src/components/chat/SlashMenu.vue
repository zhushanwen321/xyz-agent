<template>
  <Teleport to="body">
    <div
      v-if="visible && commands.length > 0"
      ref="menuRef"
      class="slash-menu"
      :style="menuStyle"
    >
      <div class="slash-menu__list" ref="listRef">
        <Button
          v-for="(cmd, idx) in commands"
          :key="cmd.name"
          :ref="(el) => { if (idx === activeIndex) activeEl = (el as any)?.$el ?? el }"
          variant="ghost"
          :class="['slash-menu__item', { 'slash-menu__item--active': idx === activeIndex }]"
          @click="handleSelect(cmd.name)"
          @mouseenter="activeIndex = idx"
        >
          <span class="slash-menu__name">/{{ cmd.name }}</span>
          <span class="slash-menu__desc">{{ cmd.description }}</span>
        </Button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { useSlashCommands } from '../../composables/useSlashCommands'
import { useProviderStore } from '../../stores/provider'
import { Button } from '../../design-system'

const props = defineProps<{
  visible: boolean
  filter: string
}>()

const emit = defineEmits<{
  close: []
  select: [name: string]
}>()

const { filteredCommands, setFilter, initDefaultCommands } = useSlashCommands()
const providerStore = useProviderStore()

initDefaultCommands()

const activeIndex = ref(0)
const activeEl = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)

// 动态定位：基于 anchor 元素（chat-input-wrap）的位置计算
const menuStyle = ref<Record<string, string>>({})

const commands = computed(() => {
  const skills = providerStore.skills
    .filter(s => s.enabled)
    .map(s => ({ name: s.name, description: s.description }))
  return [...filteredCommands.value, ...skills]
})

function updatePosition() {
  // 查找 chat-input-wrap 作为定位锚点
  const anchor = document.querySelector('.chat-input-wrap')
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  menuStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    bottom: `${window.innerHeight - rect.top + 6}px`,
    width: `${rect.width}px`,
    zIndex: '9999',
  }
}

watch(() => props.filter, (val) => {
  setFilter(val)
  activeIndex.value = 0
})

watch(() => props.visible, (val) => {
  if (val) {
    activeIndex.value = 0
    nextTick(updatePosition)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', updatePosition)
  } else {
    document.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', updatePosition)
  }
})

function onKeyDown(e: KeyboardEvent) {
  if (!props.visible || commands.value.length === 0) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % commands.value.length
    scrollActiveIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + commands.value.length) % commands.value.length
    scrollActiveIntoView()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const cmd = commands.value[activeIndex.value]
    if (cmd) handleSelect(cmd.name)
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

function handleSelect(name: string) {
  emit('select', name)
}

// 点击外部关闭
function onOutsideClick(e: MouseEvent) {
  if (!props.visible) return
  const target = e.target as HTMLElement
  if (menuRef.value?.contains(target)) return
  // 不在菜单内，也不在输入框内时关闭
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
  window.removeEventListener('resize', updatePosition)
})
</script>

<style scoped>
.slash-menu {
  max-height: 280px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.slash-menu__list {
  max-height: 260px;
  overflow-y: auto;
  padding: 4px 0;
}

.slash-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: none;
  color: var(--fg);
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  transition: background 0.1s var(--ease);
}

.slash-menu__item:hover,
.slash-menu__item--active {
  background: var(--accent-light);
}

.slash-menu__name {
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-mono);
  white-space: nowrap;
  color: var(--accent);
  min-width: 140px;
}

.slash-menu__desc {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
