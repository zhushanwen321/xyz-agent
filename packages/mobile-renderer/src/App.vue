<script setup lang="ts">
// w1 最小 stub（spec P4 w1-skeleton）。
// w2 接 i18n + copy 业务层后，App.vue 将改为连接态门控（s2 的 MobileShell / MobileConnectScreen）。
</script>

<template>
  <div class="mobile-app-root">mobile-renderer</div>
</template>

<style scoped>
.mobile-app-root {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg);
  background: var(--bg);
  font-family: var(--font-sans);
}
</style>
