<template>
  <!--
    Settings · Agent 菜单页（handoff-agent.md · 层 A 加载路径 + 层 B 只读预览）。
    与 SkillPage 同构，差异：无 pi-install 来源、改写 agentDirs、生效时机需重开会话。
  -->
  <div class="flex flex-col gap-4">
    <!-- 层 A · 加载路径 -->
    <section>
      <h3 class="mb-2 text-[12px] font-medium text-fg">加载路径</h3>

      <div class="mb-2 rounded-md border border-border bg-bg">
        <div class="px-3 py-2 text-[11px] text-muted">强制目录（不可关闭、不可拖动）</div>
        <div v-for="dir in forcedDirs" :key="dir" class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]">
          <span class="size-4 shrink-0 rounded bg-surface-hover text-center text-[10px] leading-4 text-subtle">&#10003;</span>
          <span class="font-mono text-fg opacity-60">{{ dir }}</span>
          <span class="ml-auto text-[10px] text-subtle">强制</span>
        </div>
      </div>

      <div class="rounded-md border border-border bg-bg">
        <div class="px-3 py-2 text-[11px] text-muted">可选目录（可勾选、可拖动排序，靠前覆盖靠后）</div>
        <div v-for="dir in optionalDirs" :key="dir.path" class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]">
          <span class="cursor-grab text-subtle hover:text-fg" title="拖动排序">&#x2801;&#x2801;</span>
          <input type="checkbox" :checked="dir.enabled" class="size-3.5 shrink-0 accent-[var(--accent)]" />
          <span class="font-mono text-fg">{{ dir.path }}</span>
        </div>
      </div>

      <p class="mt-1.5 text-[11px] text-subtle">改后需重开会话生效</p>
    </section>

    <!-- 层 B · Agent 只读预览 -->
    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-[12px] font-medium text-fg">已发现的 Agent</h3>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-subtle">{{ filteredAgents.length }}</span>
        <div class="ml-auto flex gap-0.5">
          <Button
            variant="ghost"
            v-for="tab in sourceTabs"
            :key="tab.id"
            class="h-auto rounded-sm px-2 py-0.5 text-[11px]"
            :class="activeSource === tab.id ? 'bg-surface-hover text-fg' : 'text-muted hover:text-fg'"
            @click="activeSource = tab.id"
          >{{ tab.label }}</Button>
        </div>
      </div>

      <div v-if="!filteredAgents.length" class="py-8 text-center text-[12px] text-muted">未发现 Agent</div>

      <div v-for="ag in filteredAgents" :key="ag.id" class="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
        <span class="flex-1 truncate text-[12px] font-medium text-fg">{{ ag.name }}</span>
        <span class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="sourceBadgeClass(ag.source ?? '')">{{ ag.source }}</span>
        <span v-if="ag.enabled" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">生效</span>
        <span class="max-w-[200px] truncate text-[11px] text-subtle" :title="ag.description">{{ ag.description }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentInfo } from '@xyz-agent/shared'
import { Button } from '@/components/ui/button'

const props = defineProps<{ agents: AgentInfo[] }>()

const forcedDirs = ['~/.xyz-agent/agents', '.xyz-agent/agents']
const optionalDirs = [
  { path: '~/.pi/agent/agents', enabled: true },
  { path: '~/.claude/agents', enabled: true },
  { path: '~/.agents/agents', enabled: true },
  { path: '.agents/agents', enabled: false },
]

const sourceTabs = [
  { id: 'all', label: '全部' },
  { id: 'pi', label: 'Pi' },
  { id: 'claude', label: 'Claude' },
  { id: 'agents', label: 'Agents' },
] as const

const activeSource = ref<string>('all')

const filteredAgents = computed(() =>
  activeSource.value === 'all'
    ? props.agents
    : props.agents.filter((a) => a.source === activeSource.value),
)

function sourceBadgeClass(source: string): string {
  const map: Record<string, string> = {
    pi: 'bg-accent-soft text-accent',
    claude: 'bg-amber-500/10 text-amber-500',
    agents: 'bg-emerald-500/10 text-emerald-500',
  }
  return map[source] ?? 'bg-surface text-muted'
}
</script>
