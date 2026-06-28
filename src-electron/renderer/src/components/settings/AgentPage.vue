<template>
  <!--
    Settings · Agent 菜单页（handoff-agent.md · 层 A 加载路径 + 层 B 只读预览）。
    与 SkillPage 同构（ADR-0020 §1.1：skill/agent 统一目录级管道模型）。
    差异：无 pi-install 来源、生效需重开会话（AgentRegistry 单例约束）。
  -->
  <div class="flex flex-col gap-4">
    <!-- 层 A · 加载路径（共享组件，接 store agentDirs） -->
    <LoadPaths
      kind="agent"
      :forced-dirs="forcedDirs"
      :dirs="agentDirs"
      :disabled="false"
      @update-dirs="onUpdateDirs"
    />

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

      <!-- ADR §5：只读预览，无开关无 CRUD。 -->
      <div v-for="ag in filteredAgents" :key="ag.id" class="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
        <span class="flex-1 truncate text-[12px] font-medium text-fg">{{ ag.name }}</span>
        <span class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="sourceBadgeClass(ag.source ?? '')">{{ ag.source }}</span>
        <span v-if="ag.effective" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">生效</span>
        <span class="max-w-[200px] truncate text-[11px] text-subtle" :title="ag.description">{{ ag.description }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import LoadPaths from './LoadPaths.vue'
import type { AgentInfo, SkillDirConfig } from '@xyz-agent/shared'
import { config } from '@/api'

const props = defineProps<{
  agents: AgentInfo[]
  /** 加载路径配置（来自 settings store，ADR-0020 §1 discovery.json SSOT 视图） */
  agentDirs: SkillDirConfig[]
}>()

const emit = defineEmits<{
  /** 目录配置变更 → 父组件写回 store（setAgentDirs） */
  'update-agent-dirs': [dirs: SkillDirConfig[]]
}>()

// ADR-0020 §1.1 强制目录（桥接层硬编码注入）
const forcedDirs = ['~/.xyz-agent/agents', '.xyz-agent/agents']

const sourceTabs = [
  { id: 'all', label: '全部' },
  { id: 'pi', label: 'Pi' },
  { id: 'claude', label: 'Claude' },
  { id: 'agents', label: 'Agents' },
] as const

const activeSource = ref<string>('all')
const scanning = ref(false)
const actionError = ref('')

const filteredAgents = computed(() =>
  activeSource.value === 'all'
    ? props.agents
    : props.agents.filter((a) => a.source === activeSource.value),
)

/** 加载路径变更（勾选/拖排序）→ emit 给父组件，由 SettingsModal 统一写 store（避免重复请求）。
 * 拖拽即时性由 LoadPaths 本地状态保证，这里只负责持久化（发后即忘）。 */
function onUpdateDirs(dirs: SkillDirConfig[]): void {
  actionError.value = ''
  emit('update-agent-dirs', dirs)
}

/** 重新扫描（裂缝①已修：扫描后广播）。 */
async function onScan() {
  scanning.value = true
  actionError.value = ''
  try {
    await config.scanAgents(props.agentDirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
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
