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
</script>

<template>
  <div class="s-import-section">
    <div class="s-import-section__title">{{ title }}</div>
    <div class="s-import-paths">
      <div
        v-for="src in localSources"
        :key="src.id"
        :class="['s-import-path', { active: src.active }]"
        @click="src.active = !src.active"
      >
        <span :class="['s-import-path__icon', `s-import-path__icon--${src.id}`]" :style="src.iconBg ? { background: src.iconBg } : {}">{{ src.icon }}</span>
        <span>
          <span class="s-import-path__label">{{ src.label }}</span><br>
          <span class="s-import-path__path">{{ src.path }}</span>
        </span>
      </div>
    </div>
    <div class="s-custom-path">
      <Input class="s-custom-path__input" :placeholder="customPlaceholder" />
      <Button variant="ghost" size="sm">扫描</Button>
    </div>
  </div>
</template>


