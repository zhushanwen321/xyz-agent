<script setup lang="ts">
/** macOS traffic-light（红黄绿窗口控制圆点）*/
</script>

<template>
  <div class="traffic-light">
    <span class="tl-dot close"></span>
    <span class="tl-dot min"></span>
    <span class="tl-dot max"></span>
  </div>
</template>

<style scoped>
.traffic-light {
  position: absolute;
  left: 16px;
  top: 26px;
  display: flex;
  gap: 8px;
  z-index: var(--z-popover);
}
.tl-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.25);
}
.tl-dot.close { background: #ff5f57; }
.tl-dot.min { background: #febc2e; }
.tl-dot.max { background: #28c840; }
</style>
