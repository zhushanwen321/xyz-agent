export default {
  props: ['tab'],
  emits: ['close', 'update:tab'],
  template: `
    <!-- Drawer header -->
    <div class="h-11 flex items-center justify-between px-4 border-b border-white/[0.06] flex-shrink-0">
      <div class="flex items-center gap-3 text-xs">
        <button
          class="px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-panel-hover"
          :class="tab==='diff' ? 'text-text-primary bg-panel-hover' : ''"
          @click="$emit('update:tab', 'diff')"
        >Diff</button>
        <button
          class="px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-panel-hover"
          :class="tab==='browser' ? 'text-text-primary bg-panel-hover' : ''"
          @click="$emit('update:tab', 'browser')"
        >浏览器</button>
        <button
          class="px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-panel-hover"
          :class="tab==='terminal' ? 'text-text-primary bg-panel-hover' : ''"
          @click="$emit('update:tab', 'terminal')"
        >终端</button>
      </div>
      <button class="text-text-secondary hover:text-text-primary" @click="$emit('close')">✕</button>
    </div>

    <!-- Drawer body -->
    <div class="flex-1 overflow-y-auto thin-scroll p-4">
      <div v-if="tab==='diff'" class="font-mono text-xs leading-relaxed space-y-1">
        <div class="text-text-secondary mb-2">subagent-tool.ts</div>
        <div class="text-red-400">- import { getRuntime } from "../runtime/runtime.ts";</div>
        <div class="text-green-400">+ import { getHub } from "../runtime/subagent-hub.ts";</div>
        <div class="h-px bg-white/[0.06] my-2"></div>
        <div class="text-text-secondary mb-2">tui/progress-widget.ts</div>
        <div class="text-red-400">- SubagentRuntime</div>
        <div class="text-green-400">+ SubagentHub</div>
      </div>

      <div v-else-if="tab==='browser'" class="h-full flex flex-col items-center justify-center text-text-secondary text-sm">
        <div class="w-full aspect-video bg-panel border border-white/[0.06] rounded-lg flex items-center justify-center mb-3">
          <span>about:blank</span>
        </div>
        <div>浏览器预览区域</div>
      </div>

      <div v-else-if="tab==='terminal'" class="font-mono text-xs text-text-secondary space-y-1">
        <div><span class="text-text-tertiary">$</span> npm run typecheck</div>
        <div class="text-green-400">✓ 0 errors</div>
        <div class="text-text-tertiary">$ _</div>
      </div>
    </div>`
}
