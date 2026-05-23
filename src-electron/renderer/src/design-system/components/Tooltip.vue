<script setup lang="ts">
import { computed } from 'vue'
import {
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
  TooltipArrow,
  TooltipProvider,
} from 'radix-vue'
import { cn } from '../utils'

type Position = 'top' | 'bottom' | 'left' | 'right'

interface Props {
  content: string
  position?: Position
}

const props = withDefaults(defineProps<Props>(), {
  position: 'top',
})

const sideMap: Record<Position, 'top' | 'bottom' | 'left' | 'right'> = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
}

const contentClasses = computed(() =>
  cn(
    'z-50 overflow-hidden rounded-sm px-3 py-1.5 text-xs animate-in fade-in-0 zoom-in-95',
    'shadow-md',
  ),
)
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>

      <TooltipPortal>
        <TooltipContent
          :side="sideMap[props.position]"
          :side-offset="6"
          :class="contentClasses"
          :style="{
            background: 'var(--surface)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
          }"
          role="tooltip"
        >
          {{ content }}
          <TooltipArrow
            :style="{ fill: 'var(--surface)' }"
            :width="8"
            :height="4"
          />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
