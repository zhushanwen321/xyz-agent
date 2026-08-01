<script setup lang="ts">
/** MessageStream · 对话流入口（v6 spec-container §1）
 *  - .ms-scroll：flex:1 overflow-y-auto 滚动 + padding 20px（px-5 pt-5），用 flex gap-3.5 控制 turn 间距
 *  - 每 turn：UserBubble（720 居中 wrap + 76% 右浮气泡）+ assistant 区（720 居中列）
 *  - TurnSummary hover 域 = 整个 assistant turn（.ms-assistant-col:hover → .ts-actions 唤出）
 *  - fork/handoff 事件 → stagedAction（composer 出 staging chip + 聚焦输入，+Q 变体）
 *  - 底部留空给 Composer（外层布局控制） */
import { chatTurns, type ChatBlock, type ChatTurn } from '@/mock/sessions'
import { stagedAction } from '@/composables/useStore'
import UserBubble from './UserBubble.vue'
import TurnMeta from './TurnMeta.vue'
import TurnSummary from './TurnSummary.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import BashBlock from './BashBlock.vue'
import ToolBlock from './ToolBlock.vue'
import ChangeSetCard from './ChangeSetCard.vue'
import SubagentBlock from './SubagentBlock.vue'
import WorkflowBlock from './WorkflowBlock.vue'
import TurnRail from './TurnRail.vue'
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

/** subagent 差异帧（spec §12.6 帧⑦）：turn 含 subagent block → TurnSummary 仅 copy 无 fork/handoff */
function turnVariant(turn: ChatTurn): 'normal' | 'subagent' {
  return turn.blocks.some((b) => b.type === 'subagent') ? 'subagent' : 'normal'
}

/** fork/handoff → +Q 变体：stagedAction 由 Composer 消费（staging chip + 聚焦输入） */
function stageAction(type: 'fork' | 'handoff') {
  stagedAction.value = { type }
}
</script>

<template>
  <div class="ms-scroll">
      <!-- TurnRail · turn 导航窄条（IF4），贴滚动区右缘，hover 展开 mini-map -->
      <TurnRail />
      <div v-for="turn in chatTurns" :key="turn.id" class="ms-turn">
        <!-- user message：720 居中 wrap，气泡内右浮 max-w-76% -->
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
            :variant="turnVariant(turn)"
            @fork="stageAction('fork')"
            @handoff="stageAction('handoff')"
          />
          <TurnSummary
            v-else
            :streaming="true"
            :text="streamingSummary"
            :variant="turnVariant(turn)"
          />
        </div>
      </div>
  </div>
</template>

<style scoped>
.ms-scroll {
  position: relative; /* TurnRail absolute 定位锚点 */
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden; /* 禁止横向滚动（TurnRail 绝对定位 + 代码块等宽内容不撑出滚动条）*/
  min-height: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-anchor: none;
}
.ms-turn {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ms-assistant-col {
  max-width: var(--content-max-w);
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}
/* TurnSummary actions hover 域（spec §12.6）：hover 整个 assistant turn 即唤出，不只 summary 自身
   （.ms-turn 前缀提 specificity，压过 TurnSummary scoped 的 .ts-wrap:hover 同级规则） */
.ms-turn .ms-assistant-col:hover :deep(.ts-actions),
.ms-turn .ms-assistant-col:focus-within :deep(.ts-actions) { opacity: 1; }
</style>
