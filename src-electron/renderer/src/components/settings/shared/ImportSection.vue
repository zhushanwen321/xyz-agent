<script setup lang="ts">
import { ref } from 'vue'
import { Button, Input } from '../../../design-system'

export interface ImportSource {
  id: string
  icon: string
  label: string
  path: string
  iconBg?: string
  active?: boolean
}

const props = withDefaults(defineProps<{
  title: string
  sources: ImportSource[]
  customPlaceholder?: string
}>(), {
  customPlaceholder: '自定义路径',
})

const localSources = ref(props.sources.map(s => ({ ...s })))

const iconClassMap: Record<string, string> = {
  pi: 'bg-accent',
  claude: 'bg-[oklch(60%_0.15_280)]',
  agents: 'bg-success',
}
</script>

<template>
  <div class="mb-6">
    <div class="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted mb-3 pb-1.5 border-b border-border">{{ title }}</div>
    <div class="flex flex-wrap gap-2 mb-3">
      <div
        v-for="src in localSources"
        :key="src.id"
        :class="['flex items-center gap-2 py-2 px-3.5 border rounded-sm cursor-pointer transition-all duration-150 ease-ease text-[13px] select-none',
          src.active ? 'border-accent bg-accent-light text-accent' : 'border-border hover:border-accent hover:bg-accent-light',
        ]"
        @click="src.active = !src.active"
      >
        <span :class="['w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-white shrink-0', iconClassMap[src.id] ?? 'bg-accent']" :style="src.iconBg ? { background: src.iconBg } : {}">{{ src.icon }}</span>
        <span>
          <span class="font-medium">{{ src.label }}</span><br>
          <span class="font-mono text-[11px] text-muted">{{ src.path }}</span>
        </span>
      </div>
    </div>
    <div class="flex gap-2 items-center">
      <Input class="flex-1" :placeholder="customPlaceholder" />
      <Button size="sm">扫描</Button>
    </div>
  </div>
</template>


