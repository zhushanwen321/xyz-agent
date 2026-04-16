<script setup lang="ts">
import { ref, computed } from 'vue'
import type { TaskNode, OrchestrateNode } from '../types'
import SubAgentCard from './SubAgentCard.vue'
import TaskTreeView from './TaskTreeView.vue'

const props = defineProps<{
  taskNodes: Map<string, TaskNode>
  orchestrateNodes: Map<string, OrchestrateNode>
}>()

const activeTab = ref<'subagents' | 'orchestrate'>('subagents')
const selectedNodeId = ref<string | null>(null)
const anchorNodeId = ref<string | null>(null)

const emit = defineEmits<{
  killTask: [taskId: string]
  selectNode: [nodeId: string]
}>()

// 按创建时间倒序排列，最新的在上面
const sortedTasks = computed(() =>
  [...props.taskNodes.values()].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
)

const activeTaskCount = computed(() =>
  [...props.taskNodes.values()].filter(t => t.status === 'running').length
)

const completedTaskCount = computed(() =>
  [...props.taskNodes.values()].filter(t => t.status === 'completed').length
)

const hasContent = computed(() =>
  props.taskNodes.size > 0 || props.orchestrateNodes.size > 0
)
</script>

<template>
  <aside v-if="hasContent" class="w-72 flex flex-col border-l border-border-default bg-elevated">
    <!-- Tab 切换 -->
    <div class="flex border-b border-border-default">
      <button
        class="flex-1 px-3 py-2 text-[12px] font-mono transition-colors"
        :class="activeTab === 'subagents' ? 'text-foreground border-b-2 border-b-blue-500' : 'text-muted-foreground hover:text-foreground'"
        @click="activeTab = 'subagents'"
      >
        SubAgents ({{ taskNodes.size }})
      </button>
      <button
        class="flex-1 px-3 py-2 text-[12px] font-mono transition-colors"
        :class="activeTab === 'orchestrate' ? 'text-foreground border-b-2 border-b-blue-500' : 'text-muted-foreground hover:text-foreground'"
        @click="activeTab = 'orchestrate'"
      >
        Orchestrate ({{ orchestrateNodes.size }})
      </button>
    </div>

    <!-- 内容区 -->
    <div class="flex-1 overflow-y-auto p-2 space-y-2">
      <!-- SubAgents Tab -->
      <template v-if="activeTab === 'subagents'">
        <SubAgentCard
          v-for="task in sortedTasks"
          :key="task.task_id"
          :task="task"
          :class="{ 'ring-1 ring-blue-500/50': selectedNodeId === task.task_id }"
          @kill="emit('killTask', task.task_id)"
          @open-tab="selectedNodeId = task.task_id; emit('selectNode', task.task_id)"
        />
        <div v-if="sortedTasks.length === 0" class="text-center text-muted-foreground text-[11px] py-4">
          No sub-agents
        </div>
      </template>

      <!-- Orchestrate Tab -->
      <template v-else>
        <TaskTreeView
          :nodes="orchestrateNodes"
          :selected-node-id="selectedNodeId"
          :anchor-node-id="anchorNodeId"
          @select="selectedNodeId = $event; emit('selectNode', $event)"
          @kill="emit('killTask', $event)"
          @anchor="anchorNodeId = $event; if ($event) emit('selectNode', $event)"
        />
        <div v-if="orchestrateNodes.size === 0" class="text-center text-muted-foreground text-[11px] py-4">
          No orchestrate nodes
        </div>
      </template>
    </div>

    <!-- 底部统计 -->
    <div class="border-t border-border-default px-3 py-1.5 text-[10px] text-muted-foreground font-mono flex justify-between">
      <span>Active: <span class="text-[#22c55e]">{{ activeTaskCount }}</span></span>
      <span>Completed: {{ completedTaskCount }}</span>
    </div>
  </aside>
</template>
