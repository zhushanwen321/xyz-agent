<script setup lang="ts">
defineProps<{
  items: Array<{ key: string; value: string }>
}>()
</script>

<template>
  <div class="meta-grid">
    <template v-for="item in items" :key="item.key">
      <span class="meta-grid__key">{{ item.key }}</span>
      <span class="meta-grid__val">{{ item.value }}</span>
    </template>
  </div>
</template>

<style scoped>
.meta-grid {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 4px 12px;
  font-size: 12px;
  margin-bottom: 12px;
}

.meta-grid__key {
  color: var(--muted);
  font-weight: 500;
}

.meta-grid__val {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg);
  word-break: break-all;
}
</style>
