export default {
  props: ['icon', 'label', 'active'],
  template: `
    <div class="group flex items-center gap-3 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors"
         :class="active ? 'bg-white/[0.07] text-text-primary' : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'">
      <span v-html="icon" class="w-4 h-4 flex items-center justify-center opacity-80 group-hover:opacity-100"></span>
      <span class="text-[13px]">{{ label }}</span>
    </div>`
}
