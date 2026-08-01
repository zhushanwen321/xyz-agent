<script setup lang="ts">
/** MessageStream · 对话流入口（v6 spec-container §1）
 *  - flex:1 overflow-y-auto 滚动容器
 *  - .ms-inner：720 居中列
 *  - 每 turn：UserBubble（列内右浮 max-w-76%）+ assistant 区（720 居中 TurnMeta + blocks + TurnSummary）
 *  - 底部留空给 Composer（外层布局控制） */
import { chatTurns, type ChatBlock } from '@/mock/sessions'
import UserBubble from './UserBubble.vue'
import TurnMeta from './TurnMeta.vue'
import TurnSummary from './TurnSummary.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import BashBlock from './BashBlock.vue'
import ToolBlock from './ToolBlock.vue'
import ChangeSetCard from './ChangeSetCard.vue'
import SubagentBlock from './SubagentBlock.vue'
import WorkflowBlock from './WorkflowBlock.vue'
import { markRaw, type Component } from 'vue'

/** block 类型 → 组件映射（markRaw 避免响应式开销） */
const blockMap: Record<string, Component> = {
  thinking: markRaw(ThinkingBlock),
  bash: markRaw(BashBlock),
  tool: markRaw(ToolBlock),
  changeset: markRaw(ChangeSetCard),
  subagent: markRaw(SubagentBlock),
  workflow: markRaw(WorkflowBlock),
}
function resolveBlock(type: ChatBlock['type']): Component {
  return blockMap[type] || WorkflowBlock
}

/** demo：最后一个 turn 的 assistant 区显 streaming 收尾（含 cursor） */
const streamingTurnId = 'turn-2'
const streamingSummary = '正在汇总本轮的执行结果…'
const doneSummary = '完成。已对照 v6 spec 落地视觉规则，圆角/分隔/灰度分布均收敛到 token 体系。'
</script>

<template>
  <div class="ms-scroll">
    <div class="ms-inner">
      <div v-for="turn in chatTurns" :key="turn.id" class="ms-turn">
        <!-- user message：列内右浮 -->
        <UserBubble :message="turn.userMessage" />

        <!-- assistant 区：720 居中列 -->
        <div class="ms-assistant-col">
          <TurnMeta :blocks="turn.blocks" :streaming="turn.id === streamingTurnId" />

          <component
            :is="resolveBlock(block.type)"
            v-for="(block, i) in turn.blocks"
            :key="i"
            :data="block.data"
          />

          <TurnSummary
            v-if="turn.id !== streamingTurnId"
            :text="doneSummary"
          />
          <TurnSummary
            v-else
            :streaming="true"
            :text="streamingSummary"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ms-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.ms-inner {
  max-width: var(--content-max-w);
  margin: 0 auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
}
.ms-turn {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ms-turn + .ms-turn { margin-top: 28px; }
.ms-assistant-col {
  display: flex;
  flex-direction: column;
}
</style>
