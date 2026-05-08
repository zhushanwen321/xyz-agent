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
  <div class="anchor" :class="{ open }" ref="anchorRef">
    <Button variant="ghost" class="anchor__trigger" @click.stop="toggle">
      <span class="anchor__dot" :style="{ background: currentColor }"></span>
      <span class="anchor__label">{{ currentLabel }}</span>
      <span class="anchor__chevron">&#9662;</span>
    </Button>
    <div v-if="open" class="anchor-dropdown">
      <div
        v-for="opt in options"
        :key="opt.id"
        :class="['anchor-opt', { current: opt.id === currentId }]"
        @click="pick(opt.id)"
      >
        <span class="anchor-opt__dot" :style="{ background: opt.color || 'var(--success)' }"></span>
        {{ opt.label }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.anchor {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--fg);
  font-weight: 600;
  font-size: 12px;
  transition: background 0.15s var(--ease);
  position: relative;
  user-select: none;
}
.anchor:hover {
  background: var(--accent-light);
}
.anchor__trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: inherit;
}
.anchor__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.anchor__label {
  line-height: 1;
}
.anchor__chevron {
  font-size: 9px;
  color: var(--muted);
  margin-left: 2px;
  transition: transform 0.15s var(--ease);
}
.anchor.open .anchor__chevron {
  transform: rotate(180deg);
}

/* Dropdown */
.anchor-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  min-width: 220px;
  z-index: 30;
  overflow: hidden;
}
.anchor-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s var(--ease);
  color: var(--fg);
  font-weight: 400;
}
.anchor-opt:hover {
  background: var(--accent-light);
}
.anchor-opt.current {
  font-weight: 600;
  color: var(--accent);
}
.anchor-opt__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
