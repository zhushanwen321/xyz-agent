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

const emit = defineEmits<{
  killTask: [taskId: string]
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

const hasContent = computed(() =>
  props.taskNodes.size > 0 || props.orchestrateNodes.size > 0
)
</script>

<template>
  <aside v-if="hasContent" class="w-72 flex flex-col border-l border-border-default bg-bg-elevated">
    <!-- Tab 切换 -->
    <div class="flex border-b border-border-default">
      <button
        class="flex-1 px-3 py-2 text-[12px] font-mono transition-colors"
        :class="activeTab === 'subagents' ? 'text-text-primary border-b-2 border-b-blue-500' : 'text-text-secondary hover:text-text-primary'"
        @click="activeTab = 'subagents'"
      >
        SubAgents ({{ taskNodes.size }})
      </button>
      <button
        class="flex-1 px-3 py-2 text-[12px] font-mono transition-colors"
        :class="activeTab === 'orchestrate' ? 'text-text-primary border-b-2 border-b-blue-500' : 'text-text-secondary hover:text-text-primary'"
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
          @kill="emit('killTask', task.task_id)"
        />
        <div v-if="sortedTasks.length === 0" class="text-center text-text-secondary text-[11px] py-4">
          No sub-agents
        </div>
      </template>

      <!-- Orchestrate Tab -->
      <template v-else>
        <TaskTreeView :nodes="orchestrateNodes" />
        <div v-if="orchestrateNodes.size === 0" class="text-center text-text-secondary text-[11px] py-4">
          No orchestrate nodes
        </div>
      </template>
    </div>

    <!-- 底部统计 -->
    <div class="border-t border-border-default px-3 py-1.5 text-[10px] text-text-secondary font-mono">
      Active: {{ activeTaskCount }}
    </div>
  </aside>
</template>
