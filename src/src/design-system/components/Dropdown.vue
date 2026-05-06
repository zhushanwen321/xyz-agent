<script setup lang="ts">
import { computed } from 'vue'
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
} from 'radix-vue'
import { cn } from '../utils'

interface DropdownItem {
  label: string
  value: string
  icon?: string
}

interface Props {
  items: DropdownItem[]
  trigger?: 'click' | 'hover'
}

withDefaults(defineProps<Props>(), {
  trigger: 'click',
})

const emit = defineEmits<{
  select: [value: string]
}>()

const contentClasses = computed(() =>
  cn(
    'z-50 min-w-[8rem] overflow-hidden rounded-md p-1 shadow-md',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
    'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
  ),
)

const itemClasses = computed(() =>
  cn(
    'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none',
    'transition-colors',
    'data-[highlighted]:opacity-90',
  ),
)
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        :class="contentClasses"
        :side-offset="4"
        align="start"
        :style="{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
        }"
        role="menu"
      >
        <DropdownMenuItem
          v-for="item in items"
          :key="item.value"
          :class="itemClasses"
          style="color: var(--color-text-primary)"
          role="menuitem"
          @select="emit('select', item.value)"
        >
          <span v-if="item.icon" class="mr-2 inline-flex h-4 w-4 items-center justify-center text-xs">
            {{ item.icon }}
          </span>
          <span>{{ item.label }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
