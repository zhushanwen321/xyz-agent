<script setup lang="ts">
defineProps<{
  items: Array<{ key: string; value: string }>
}>()
</script>

<template>
  <div class="s-meta-grid">
    <template v-for="item in items" :key="item.key">
      <span class="s-meta-grid__key">{{ item.key }}</span>
      <span class="s-meta-grid__val">{{ item.value }}</span>
    </template>
  </div>
</template>
