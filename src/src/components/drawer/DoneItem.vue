<template>
  <div class="done-item">
    <div class="done-item__hd">
      <span class="done-item__dot"></span>
      <div class="done-item__info">
        <div class="done-item__name">{{ name }}</div>
        <div class="done-item__summary">{{ summary }}</div>
      </div>
      <div v-if="duration" class="done-item__meta">{{ duration }}</div>
    </div>
    <div class="done-item__action">
      <a class="done-item__link" @click.prevent="$emit('view')">查看结果 →</a>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  id: string
  name: string
  summary: string
  duration?: string
}>()

defineEmits<{
  view: []
}>()
</script>
