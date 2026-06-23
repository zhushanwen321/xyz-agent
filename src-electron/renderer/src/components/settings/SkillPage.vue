<template>
  <!--
    Settings · Skill 菜单页（handoff-skill.md · 层 A 加载路径 + 层 B 只读预览）。
  -->
  <div class="flex flex-col gap-4">
    <!-- 层 A · 加载路径 -->
    <section>
      <h3 class="mb-2 text-[12px] font-medium text-fg">加载路径</h3>

      <!-- 强制目录 -->
      <div class="mb-2 rounded-md border border-border bg-bg">
        <div class="px-3 py-2 text-[11px] text-muted">强制目录（不可关闭）</div>
        <div v-for="dir in forcedDirs" :key="dir" class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]">
          <span class="size-4 shrink-0 rounded bg-surface-hover text-center text-[10px] leading-4 text-subtle">&#10003;</span>
          <span class="font-mono text-fg opacity-60">{{ dir }}</span>
          <span class="ml-auto text-[10px] text-subtle">强制</span>
        </div>
      </div>

      <!-- 可选目录 -->
      <div class="rounded-md border border-border bg-bg">
        <div class="px-3 py-2 text-[11px] text-muted">可选目录（可勾选、可拖动排序）</div>
        <div v-for="dir in optionalDirs" :key="dir.path" class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]">
          <span class="cursor-grab text-subtle hover:text-fg" title="拖动排序">&#x2801;&#x2801;</span>
          <input type="checkbox" :checked="dir.enabled" class="size-3.5 shrink-0 accent-[var(--accent)]" />
          <span class="font-mono text-fg">{{ dir.path }}</span>
        </div>
      </div>
    </section>

    <!-- 层 B · Skill 只读预览 -->
    <section>
      <!-- 来源 tab 过滤 -->
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-[12px] font-medium text-fg">已发现的 Skill</h3>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-subtle">{{ filteredSkills.length }}</span>
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

      <div v-if="!filteredSkills.length" class="py-8 text-center text-[12px] text-muted">未发现 Skill</div>

      <div v-for="sk in filteredSkills" :key="sk.id" class="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
        <span class="flex-1 truncate text-[12px] font-medium text-fg">{{ sk.name }}</span>
        <span class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="sourceBadgeClass(sk.source)">{{ sk.source }}</span>
        <span v-if="sk.enabled" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">生效</span>
        <span class="max-w-[200px] truncate text-[11px] text-subtle" :title="sk.description">{{ sk.description }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SkillInfo } from '@xyz-agent/shared'
import { Button } from '@/components/ui/button'

const props = defineProps<{ skills: SkillInfo[] }>()

const forcedDirs = ['~/.xyz-agent/skills', '.xyz-agent/skills']
const optionalDirs = [
  { path: '~/.pi/agent/skills', enabled: true },
  { path: '~/.claude/skills', enabled: true },
  { path: '~/.agents/skills', enabled: true },
  { path: '.agents/skills', enabled: false },
]

const sourceTabs = [
  { id: 'all', label: '全部' },
  { id: 'pi', label: 'Pi' },
  { id: 'claude', label: 'Claude' },
  { id: 'agents', label: 'Agents' },
] as const

const activeSource = ref<string>('all')

const filteredSkills = computed(() =>
  activeSource.value === 'all'
    ? props.skills
    : props.skills.filter((s) => s.source === activeSource.value),
)

function sourceBadgeClass(source: string): string {
  const map: Record<string, string> = {
    pi: 'bg-accent-soft text-accent',
    claude: 'bg-amber-500/10 text-amber-500',
    agents: 'bg-emerald-500/10 text-emerald-500',
    piinstall: 'bg-violet-500/10 text-violet-500',
  }
  return map[source] ?? 'bg-surface text-muted'
}
</script>
