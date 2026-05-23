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
  /** Controlled open state. When provided, the dropdown won't open on trigger click. */
  open?: boolean
  /** Position to render the dropdown at (for context-menu usage). */
  position?: { x: number; y: number }
}

const props = withDefaults(defineProps<Props>(), {
  trigger: 'click',
  open: undefined,
  position: undefined,
})

const emit = defineEmits<{
  select: [value: string]
  'update:open': [value: boolean]
}>()

const controlled = computed(() => props.open !== undefined)
const menuStyle = computed(() =>
  props.position
    ? { position: 'fixed' as const, left: `${props.position.x}px`, top: `${props.position.y}px` }
    : undefined,
)

const contentClasses = computed(() =>
  cn(
    'z-50 min-w-[8rem] overflow-hidden rounded-sm p-1 shadow-md',
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
  <DropdownMenuRoot
    :open="controlled ? open : undefined"
    @update:open="controlled ? emit('update:open', $event) : undefined"
  >
    <DropdownMenuTrigger v-if="!controlled" as-child>
      <slot />
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        :class="contentClasses"
        :side-offset="controlled ? 0 : 4"
        :align="controlled ? 'start' : 'start'"
        :style="[
          {
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          },
          menuStyle,
        ]"
        role="menu"
      >
        <DropdownMenuItem
          v-for="item in items"
          :key="item.value"
          :class="itemClasses"
          style="color: var(--fg)"
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
