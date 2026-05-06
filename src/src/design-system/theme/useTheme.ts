import { ref, computed } from 'vue'

const themeRef = ref<'light' | 'dark'>(
  (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light',
)

// Sync with DOM mutations
if (typeof window !== 'undefined') {
  const observer = new MutationObserver(() => {
    const current = document.documentElement.getAttribute('data-theme')
    if (current === 'light' || current === 'dark') {
      themeRef.value = current
    }
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
}

export function useTheme() {
  const currentTheme = computed(() => themeRef.value)

  function toggleTheme() {
    const next = themeRef.value === 'light' ? 'dark' : 'light'
    localStorage.setItem('xyz-agent-theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  return { currentTheme, toggleTheme }
}
