<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next'
import { useSidebarStore } from '../../stores/sidebar'
import { Button } from '../../design-system'

const sidebar = useSidebarStore()

function handleCollapse() {
  sidebar.toggle()
}
</script>

<template>
  <div class="flex items-center justify-end px-2 py-1">
    <Button
      variant="ghost"
      size="icon"
      as="button"
      title="Collapse sidebar"
      @click="handleCollapse"
    >
      <ChevronLeft :size="16" :stroke-width="1.8" />
    </Button>
  </div>
</template>
