<template>
  <!--
    v3 重建中 · 骨架占位
    Shell 将按 docs/designs/v3-demo/shell/spec.md 落地：
      aside-region（透明融合）+ main-panel（float 浮起）+ traffic light 安全区
    数据层（useConnection / ws-client / ipc）保留待 features/effects 层接入。
  -->
  <div id="app-shell" class="app-shell" />
</template>

<script setup lang="ts">
// 重建期：无业务逻辑。连接管理将在 composables/effects/useConnection 接入。
</script>

<style scoped>
.app-shell {
  height: 100vh;
  width: 100vw;
}
</style>
