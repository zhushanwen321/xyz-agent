<template>
  <div
    :class="['bg-border shrink-0 relative z-5 transition-colors duration-150 opacity-30', direction === 'horizontal' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize', { 'bg-accent opacity-100': dragging }, { 'hover:bg-accent hover:opacity-100': !dragging }]"
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

