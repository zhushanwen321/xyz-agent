<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { useSidebarStore } from '../../stores/sidebar'
import { Button } from '../../design-system'

const sidebar = useSidebarStore()

const isCollapsed = computed(() => sidebar.collapsed)

function handleToggle() {
  sidebar.toggle()
}
</script>

<template>
  <!-- Collapsed state: left edge ▸ button (fixed position expand trigger) -->
  <Button
    v-if="isCollapsed"
    variant="ghost"
    as="button"
    class="fixed top-0 left-0 z-50 w-[28px] h-full rounded-none"
    title="Expand sidebar"
    @click="handleToggle"
  >
    <ChevronRight :size="16" :stroke-width="1.8" />
  </Button>
</template>
