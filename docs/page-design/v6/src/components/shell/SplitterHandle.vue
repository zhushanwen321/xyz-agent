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
  width: 1px;
  position: relative;
  flex-shrink: 0;
  cursor: col-resize;
}
.splitter-line {
  position: absolute;
  left: -3px;
  top: 52px;
  bottom: 0;
  width: 7px;
  background: transparent;
  transition: background var(--duration-fast) var(--ease);
}
.splitter-handle:hover .splitter-line {
  background: var(--accent);
}
</style>
