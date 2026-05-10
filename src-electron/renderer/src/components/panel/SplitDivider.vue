<template>
  <div
    class="split-divider"
    :class="[`split-divider--${direction}`, { dragging }]"
    @mousedown="startDrag"
  ></div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'

const props = withDefaults(
  defineProps<{
    direction?: 'horizontal' | 'vertical'
  }>(),
  { direction: 'horizontal' }
)

const emit = defineEmits<{
  resize: [delta: number]
}>()

const isHorizontal = computed(() => props.direction === 'horizontal')
const dragging = ref(false)
let lastCoord = 0

function getCoordinate(e: MouseEvent): number {
  return isHorizontal.value ? e.clientX : e.clientY
}

function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return
  const current = getCoordinate(e)
  emit('resize', current - lastCoord)
  lastCoord = current
}

function onMouseUp() {
  dragging.value = false
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

function startDrag(e: MouseEvent) {
  dragging.value = true
  lastCoord = getCoordinate(e)
  document.body.style.cursor = isHorizontal.value ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
})
</script>

<style scoped>
.split-divider {
  background: var(--border);
  flex-shrink: 0;
  position: relative;
  z-index: 5;
  transition: background 0.15s var(--ease, ease), opacity 0.15s var(--ease, ease);
  opacity: 0.3;
}
.split-divider--horizontal {
  width: 4px;
  cursor: col-resize;
}
.split-divider--vertical {
  height: 4px;
  cursor: row-resize;
}
.split-divider:hover,
.split-divider.dragging {
  background: var(--accent);
  opacity: 1;
}
.split-divider::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 1px;
  background: transparent;
}
.split-divider--horizontal::after {
  width: 2px;
  height: 32px;
}
.split-divider--vertical::after {
  width: 32px;
  height: 2px;
}
.split-divider:hover::after,
.split-divider.dragging::after {
  background: transparent;
}
</style>
