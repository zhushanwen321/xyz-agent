<script setup lang="ts">
import { computed } from 'vue'
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from 'radix-vue'
import { cn } from '../utils'

interface TabItem {
  label: string
  value: string
}

interface Props {
  items: TabItem[]
  activeKey?: string
}

withDefaults(defineProps<Props>(), {
  activeKey: '',
})

const emit = defineEmits<{
  change: [value: string]
}>()

const listClasses = computed(() =>
  cn(
    'inline-flex h-10 items-center justify-center rounded-md p-1',
  ),
)

const triggerClasses = computed(() =>
  cn(
    'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
  ),
)

const contentClasses = computed(() =>
  cn('mt-2 focus-visible:outline-none'),
)
</script>

<template>
  <TabsRoot
    :model-value="activeKey || undefined"
    @update:model-value="emit('change', $event ?? '')"
  >
    <TabsList
      :class="listClasses"
      :style="{ background: 'var(--color-bg-base)' }"
      role="tablist"
    >
      <TabsTrigger
        v-for="item in items"
        :key="item.value"
        :value="item.value"
        :class="triggerClasses"
        :style="{
          color: 'var(--color-text-muted)',
        }"
        role="tab"
        :id="`tab-${item.value}`"
        :aria-selected="activeKey === item.value"
        :aria-controls="`panel-${item.value}`"
        :data-state="activeKey === item.value ? 'active' : 'inactive'"
      >
        {{ item.label }}
      </TabsTrigger>
    </TabsList>

    <TabsContent
      v-for="item in items"
      :key="item.value"
      :value="item.value"
      :class="contentClasses"
      role="tabpanel"
      :id="`panel-${item.value}`"
      :aria-labelledby="`tab-${item.value}`"
    >
      <slot :name="item.value" />
    </TabsContent>
  </TabsRoot>
</template>
