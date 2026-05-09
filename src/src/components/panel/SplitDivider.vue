<template>
  <div
    class="split-divider"
    :class="{ dragging }"
    @mousedown="startDrag"
  ></div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from 'vue'

const emit = defineEmits<{
  resize: [deltaX: number]
}>()

const dragging = ref(false)
let startX = 0

function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return
  emit('resize', e.clientX - startX)
  startX = e.clientX
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
  startX = e.clientX
  document.body.style.cursor = 'col-resize'
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
  width: 4px;
  background: var(--border);
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
  z-index: 5;
  transition: background 0.15s var(--ease, ease), opacity 0.15s var(--ease, ease);
  opacity: 0.3;
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
  width: 2px;
  height: 32px;
  border-radius: 1px;
  background: transparent;
}
.split-divider:hover::after,
.split-divider.dragging::after {
  background: transparent;
}
</style>
