<template>
  <!--
    展示组件 · workflow DAG 纵向分层流程图（视图 A）。
    消费 w1 的 ExecutionLayer[]：同层=并发（横向并排），不同层=串行（纵向分层）。
    点击非 pending 节点 → emit('select-agent-call', sessionId)，由父组件切 Panel。
  -->
  <div class="flex flex-col gap-4 px-1 py-1" data-testid="workflow-dag-view">
    <!-- 分层节点 -->
    <div
      v-for="(layer, layerIdx) in layers"
      :key="layer.index"
      class="relative flex flex-col gap-2"
      :data-testid="`workflow-dag-layer-${layer.index}`"
    >
      <!-- 层标签行：phase 名 + 并发标记（isParallel 时显 ×N） -->
      <div class="flex items-center gap-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wide text-neutral-dim">
          {{ layer.label }}
        </span>
        <span
          v-if="layer.isParallel"
          class="rounded-sm bg-accent-soft px-1 font-mono text-[9px] text-accent"
          data-testid="workflow-dag-parallel-flag"
        >
          ×{{ layer.nodes.length }}
        </span>
      </div>

      <!-- 节点容器：isParallel 横向并排，否则单节点纵向 -->
      <div :class="layer.isParallel ? 'flex flex-row gap-2' : 'flex flex-col gap-2'">
        <div
          v-for="node in layer.nodes"
          :key="node.id"
          class="cursor-pointer rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 transition-colors hover:bg-surface-hover"
          :class="[
            node.status === 'running'
              ? 'animate-pulse border-accent ring-1 ring-accent-ring'
              : '',
          ]"
          :title="node.status === 'pending' ? undefined : node.agent"
          data-testid="workflow-dag-node"
          @click="onNodeClick(node)"
        >
          <!-- header: agent 名 + 状态点 + stepIndex -->
          <div class="flex items-center gap-1.5">
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="callDotClass(node.status)"
            />
            <span class="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight text-neutral-fg">
              {{ node.agent }}
            </span>
            <span class="shrink-0 font-mono text-[10px] text-neutral-dim">#{{ node.id }}</span>
          </div>

          <!-- meta: 耗时（durationMs 有才显） -->
          <div
            v-if="node.durationMs !== undefined"
            class="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-neutral-dim"
          >
            <span>{{ formatDuration(node.durationMs) }}</span>
          </div>
        </div>
      </div>

      <!-- 层间连线：非最后层加竖线（::after 伪元素，Tailwind 无法表达层级连线）。 -->
      <span
        v-if="layerIdx < layers.length - 1"
        class="dag-connector pointer-events-none absolute left-1/2 top-full h-5 w-px -translate-x-1/2 bg-border-strong"
        aria-hidden="true"
      />
    </div>

    <!-- pending 区：待执行节点（虚线边框 opacity-50） -->
    <div v-if="pendingNodes.length" data-testid="workflow-dag-pending">
      <div class="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-dim">
        {{ t('panel.sideDrawer.workflowDag.pendingTitle') }}
      </div>
      <div class="flex flex-col gap-2">
        <div
          v-for="node in pendingNodes"
          :key="node.id"
          class="cursor-default rounded-md border border-dashed border-border-strong px-2.5 py-1.5 opacity-50"
          data-testid="workflow-dag-node"
        >
          <div class="flex items-center gap-1.5">
            <span class="size-1.5 shrink-0 rounded-full bg-neutral-dim" />
            <span class="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight text-neutral-fg">
              {{ node.agent }}
            </span>
            <span class="shrink-0 font-mono text-[10px] text-neutral-dim">#{{ node.id }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 空态：无 layers 且无 pending -->
    <div
      v-if="layers.length === 0 && pendingNodes.length === 0"
      class="py-8 text-center text-[11px] text-neutral-dim"
      data-testid="workflow-dag-empty"
    >
      {{ t('panel.sideDrawer.workflowDag.empty') }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * WorkflowDagView —— 纵向分层流程图（视图 A，W2 wave）。
 *
 * 纯展示组件：消费 ExecutionLayer[] + pendingNodes，渲染分层卡片。
 * 层间连线用绝对定位 span + Tailwind（bg-border-strong），不用伪元素避免 scoped style。
 * running 节点高亮用 Tailwind animate-pulse + border-accent + ring-accent-ring。
 */
import type { ExecutionLayer } from '@/composables/workflow/compute-layers'
import type { WorkflowAgentCall } from '@xyz-agent/shared'
import { callDotClass, formatDuration } from '@/composables/workflow/format'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  layers: ExecutionLayer[]
  pendingNodes: WorkflowAgentCall[]
}>()

const emit = defineEmits<{
  'select-agent-call': [agentCallSessionId: string]
}>()

/** 节点点击：pending 不可点（无 sessionId），非 pending 且有 sessionId 才 emit。 */
function onNodeClick(node: WorkflowAgentCall): void {
  if (node.status !== 'pending' && node.sessionId) {
    emit('select-agent-call', node.sessionId)
  }
}
</script>
