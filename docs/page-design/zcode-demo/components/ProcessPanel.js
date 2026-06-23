export default {
  props: ['drawerOpen'],
  emits: ['expand'],
  template: `
    <transition
      enter-active-class="transition-all duration-200 ease-out"
      leave-active-class="transition-all duration-200 ease-in"
      enter-from-class="opacity-0 scale-95"
      leave-to-class="opacity-0 scale-95"
    >
      <button
        v-if="drawerOpen"
        class="absolute top-2 right-4 z-10 float-panel px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary flex items-center gap-2"
        @click="$emit('expand')"
      >
        <span class="text-success">✓</span>
        <span>进程 9/9</span>
        <span class="text-text-tertiary">▾</span>
      </button>
    </transition>`
}
