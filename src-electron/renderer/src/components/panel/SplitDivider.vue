<template>
  <div
    :class="[
      'shrink-0 relative z-[5] transition-colors duration-150',
      direction === 'horizontal' ? 'w-[5px] cursor-col-resize' : 'h-[5px] cursor-row-resize',
    ]"
    @mousedown="startDrag"
  >
    <div
      :class="[
        'absolute transition-colors duration-150',
        direction === 'horizontal'
          ? 'top-0 bottom-0 left-[2px] w-px'
          : 'left-0 right-0 top-[2px] h-px',
        dragging
          ? 'bg-accent opacity-80'
          : 'bg-border opacity-40 hover:bg-accent hover:opacity-60',
      ]"
    />
  </div>
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

