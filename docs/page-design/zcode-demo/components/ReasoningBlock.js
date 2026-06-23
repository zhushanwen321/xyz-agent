export default {
  props: ['title', 'status'],
  template: `
    <div class="mb-4">
      <div class="flex items-center gap-2 text-text-secondary text-xs mb-1.5">
        <span v-if="status==='running'" class="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin"></span>
        <span v-else class="text-accent">✓</span>
        <span>{{ title }}</span>
      </div>
      <div class="pl-5 space-y-1.5">
        <slot />
      </div>
    </div>`
}
