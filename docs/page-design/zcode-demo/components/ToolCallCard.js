export default {
  props: ['command'],
  template: `
    <div class="bg-base border border-white/[0.06] rounded-lg px-3 py-2 font-mono text-xs text-text-secondary">
      <span class="text-text-tertiary mr-2">$</span>{{ command }}
    </div>`
}
