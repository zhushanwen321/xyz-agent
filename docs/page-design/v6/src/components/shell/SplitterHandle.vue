<script setup lang="ts">
/** SplitterResizeHandle：透明分隔条，hover/drag 显 accent */
</script>

<template>
  <div class="splitter-handle">
    <div class="splitter-line"></div>
    <!-- 命中区：6px 宽 + 左右各 2px 内缩 = 10px（spec §6）-->
    <div class="h-hit"></div>
  </div>
</template>

<style scoped>
.splitter-handle {
  width: 6px;
  margin: 0 -3px;
  position: relative;
  flex-shrink: 0;
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
/* 命中区 10px（h-hit 内缩 2px）*/
.h-hit {
  position: absolute;
  left: -2px;
  right: -2px;
  top: 0;
  bottom: 0;
  cursor: col-resize;
}
.splitter-handle:hover .splitter-line {
  background: var(--border-strong);
}
.splitter-handle:active .splitter-line {
  background: var(--accent);
  width: 2px;
}
</style>
