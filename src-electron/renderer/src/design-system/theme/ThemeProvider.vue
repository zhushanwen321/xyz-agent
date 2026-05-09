<template>
  <div :data-theme="theme">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = withDefaults(defineProps<{
  initialTheme?: 'light' | 'dark'
}>(), {
  initialTheme: 'light',
})

const emit = defineEmits<{
  'update:theme': [theme: 'light' | 'dark']
}>()

const theme = ref<'light' | 'dark'>(props.initialTheme)

function applyTheme(t: 'light' | 'dark') {
  theme.value = t
  document.documentElement.setAttribute('data-theme', t)
  emit('update:theme', t)
}

onMounted(() => {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
  const saved = localStorage.getItem('xyz-agent-theme')
  if (saved) {
    applyTheme(saved as 'light' | 'dark')
  } else {
    applyTheme(prefersDark.matches ? 'dark' : 'light')
  }

  prefersDark.addEventListener('change', (e) => {
    if (!localStorage.getItem('xyz-agent-theme')) {
      applyTheme(e.matches ? 'dark' : 'light')
    }
  })
})

function setTheme(t: 'light' | 'dark') {
  localStorage.setItem('xyz-agent-theme', t)
  applyTheme(t)
}

defineExpose({ theme, setTheme, applyTheme })
</script>
