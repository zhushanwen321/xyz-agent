import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * useLayoutStore — global UI layout state (fullscreen, etc.)
 *
 * Sidebar collapsed state lives in useSidebarStore (separate concern).
 */
export const useLayoutStore = defineStore('layout', () => {
  const isFullscreen = ref(false)

  function setFullscreen(value: boolean) {
    isFullscreen.value = value
  }

  return { isFullscreen, setFullscreen }
})
