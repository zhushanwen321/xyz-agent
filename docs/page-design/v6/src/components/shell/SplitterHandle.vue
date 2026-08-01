<script setup lang="ts">
/** SplitterResizeHandle：透明分隔条，hover/drag 显 accent */
</script>

<template>
  <div class="splitter-handle">
    <div class="splitter-line"></div>
  </div>
</template>

<style scoped>
.splitter-handle {
  width: 6px;
  margin: 0 -3px;
  position: relative;
  flex-shrink: 0;
  cursor: col-resize;
  z-index: 1;
}
.splitter-line {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: 0;
  bottom: 0;
  width: 1px;
  background: transparent;
  transition: background var(--duration) var(--ease);
}
.splitter-handle:hover .splitter-line {
  background: var(--accent);
}
.splitter-handle:active .splitter-line {
  background: var(--accent);
  width: 2px;
}
</style>
