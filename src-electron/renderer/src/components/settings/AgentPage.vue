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
        <Button
          variant="secondary"
          class="ml-1 gap-1.5 rounded-sm px-2 py-0.5 text-[11px] [&_svg]:size-3"
          :disabled="scanning"
          @click="onScan"
        >
          <RefreshCw v-if="scanning" class="animate-spin" />
          {{ scanning ? '扫描中…' : '重新扫描' }}
        </Button>
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

      <p v-if="actionError" class="mb-2 text-[11px] text-danger">{{ actionError }}</p>

      <div v-if="!filteredAgents.length" class="py-8 text-center text-[12px] text-muted">未发现 Agent</div>

      <div v-for="ag in filteredAgents" :key="ag.id" class="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
        <span class="flex-1 truncate text-[12px] font-medium text-fg">{{ ag.name }}</span>
        <span class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="sourceBadgeClass(ag.source ?? '')">{{ ag.source }}</span>
        <!-- 启用开关：调 config.setAgent 持久化 enabled -->
        <Label class="relative inline-flex shrink-0 cursor-pointer" @click.stop>
          <input type="checkbox" :checked="ag.enabled" class="peer sr-only" @change="onToggleEnabled(ag, ($event.target as HTMLInputElement).checked)" />
          <div class="h-4 w-7 rounded-full bg-border-strong after:absolute after:left-[2px] after:top-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full" />
        </Label>
        <span v-if="ag.enabled" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">生效</span>
        <span class="max-w-[200px] truncate text-[11px] text-subtle" :title="ag.description">{{ ag.description }}</span>
        <Button
          variant="ghost"
          class="size-5 shrink-0 rounded-sm p-0 text-subtle hover:bg-[rgba(239,68,68,0.12)] hover:text-danger [&_svg]:size-3"
          title="删除 Agent"
          @click.stop="deleteTarget = ag"
        >
          <Trash2 />
        </Button>
      </div>
    </section>

    <!-- 删除确认弹窗 -->
    <Dialog :open="!!deleteTarget" @update:open="deleteTarget = null">
      <DialogContent class="max-w-[360px]">
        <DialogHeader>
          <DialogTitle>删除 {{ deleteTarget?.name }}？</DialogTitle>
          <DialogDescription>将从已发现清单移除。此操作不可撤销。</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-4">
          <Button variant="ghost" @click="deleteTarget = null">取消</Button>
          <Button variant="danger" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '删除中…' : '确认删除' }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { RefreshCw, Trash2 } from '@lucide/vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { AgentInfo } from '@xyz-agent/shared'
import { config } from '@/api'

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
const scanning = ref(false)
const deleting = ref(false)
const deleteTarget = ref<AgentInfo | null>(null)
const actionError = ref('')

const filteredAgents = computed(() =>
  activeSource.value === 'all'
    ? props.agents
    : props.agents.filter((a) => a.source === activeSource.value),
)

/** 重新扫描：config.scanAgents（请求-响应，结果经 onAgents 订阅推回持久态） */
async function onScan() {
  scanning.value = true
  actionError.value = ''
  try {
    await config.scanAgents(optionalDirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
  }
}

/** 启用开关 → config.setAgent（带 enabled，状态经 onAgents 订阅推回） */
async function onToggleEnabled(ag: AgentInfo, enabled: boolean) {
  actionError.value = ''
  try {
    await config.setAgent({ ...ag, enabled })
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

/** 确认删除 → config.deleteAgent（状态经 onAgents 订阅推回） */
async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  actionError.value = ''
  try {
    await config.deleteAgent(target.id)
    deleteTarget.value = null
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

function sourceBadgeClass(source: string): string {
  const map: Record<string, string> = {
    pi: 'bg-accent-soft text-accent',
    claude: 'bg-amber-500/10 text-amber-500',
    agents: 'bg-emerald-500/10 text-emerald-500',
  }
  return map[source] ?? 'bg-surface text-muted'
}
</script>
