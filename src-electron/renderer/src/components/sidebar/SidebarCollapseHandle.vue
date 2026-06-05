<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, PanelLeftClose } from 'lucide-vue-next'
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

  <!-- Expanded state: right edge handle (narrow strip, hover highlight) -->
  <Button
    v-else
    variant="ghost"
    as="button"
    class="absolute top-0 right-0 z-10 w-[6px] h-full rounded-none hover:w-[10px]"
    title="Collapse sidebar"
    @click="handleToggle"
  >
    <PanelLeftClose :size="14" :stroke-width="1.5" class="opacity-0 hover:opacity-100 transition-opacity duration-150" />
  </Button>
</template>
