import NavItem from './components/NavItem.js'

export default {
  components: { NavItem },
  props: ['view'],
  emits: ['update:view'],
  template: `
    <div class="flex h-screen w-screen overflow-hidden bg-base p-3 gap-3">
      <aside class="w-[220px] flex-shrink-0 flex flex-col py-1">
        <div class="px-2.5 mb-4">
          <div class="flex items-center gap-2 text-text-primary font-semibold text-sm">
            <div class="w-6 h-6 rounded-md bg-accent flex items-center justify-center text-white text-xs font-bold">Z</div>
            ZCodeProject
          </div>
        </div>
        <div class="px-1.5 space-y-0.5 flex-1 thin-scroll overflow-y-auto">
          <nav-item icon="⊕" label="新建任务" :active="view==='chat'" @click="$emit('update:view','chat')" />
          <nav-item icon="⌕" label="搜索" />
          <nav-item icon="◇" label="技能" />
          <div class="h-px bg-white/[0.06] my-2 mx-2"></div>
          <nav-item icon="◈" label="subagent-skeleton" :active="view==='chat'" @click="$emit('update:view','chat')" />
          <nav-item icon="◈" label="agent-skeleton" />
          <nav-item icon="◈" label="refactor-architecture" />
          <nav-item icon="◈" label="feat-subagent-e..." />
          <div class="h-px bg-white/[0.06] my-2 mx-2"></div>
          <nav-item icon="⎔" label="ZCodeProject" />
          <nav-item icon="⚙" label="模型设置" :active="view==='settings'" @click="$emit('update:view','settings')" />
        </div>
        <div class="px-1.5 pt-2">
          <div class="flex items-center gap-2 px-2.5 py-2 text-text-secondary hover:bg-white/[0.04] rounded-lg cursor-pointer">
            <div class="w-5 h-5 rounded-full bg-zinc-700 flex items-center justify-center text-[10px]">Z</div>
            <span class="text-[13px]">ZzzzswszzZZ</span>
          </div>
        </div>
      </aside>

      <main class="flex-1 min-w-0 float-panel flex flex-col overflow-hidden">
        <slot />
      </main>
    </div>`
}
