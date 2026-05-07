<script setup lang="ts">
 

defineProps<{
  variant: 'power' | 'efficient' | 'fast'
  active: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>

<template>
  <span
    class="tag-pill"
    :class="[`tag-pill--${variant}`, { active }]"
    @click="$emit('toggle')"
  >
    <slot />
  </span>
</template>

<style scoped>
.tag-pill {
  padding: 2px 8px;
  border-radius: 100px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  transition: all 0.15s var(--ease);
  user-select: none;
}

.tag-pill:hover {
  border-color: var(--muted);
}

.tag-pill--power.active {
  background: oklch(65% 0.18 25);
  color: white;
  border-color: oklch(65% 0.18 25);
}

.tag-pill--efficient.active {
  background: oklch(60% 0.15 260);
  color: white;
  border-color: oklch(60% 0.15 260);
}

.tag-pill--fast.active {
  background: oklch(68% 0.16 145);
  color: white;
  border-color: oklch(68% 0.16 145);
}
</style>
