<template>
  <!--
    TurnMeta：回合级元信息（已工作/工作中 + badge + sticky）。
    从 Turn.vue 拆出。badge 灰阶化（H 设计：bg-surface-2 text-neutral-mid 替代彩色）。
  -->
  <!-- turn-meta + hr 包在同一 sticky wrapper：working 态贴顶时两者一起固定。
       底色用 --panel-bg（Panel 注入，随 panel 状态变化）不透明遮挡滚动文字。 -->
  <div
    v-if="turn.assistants.length > 0"
    :class="sessionActive ? 'sticky top-0 z-[1] bg-[var(--panel-bg,var(--surface))]' : ''"
    :data-testid="`turn-meta-${turnIndex}`"
  >
    <Button
      variant="ghost"
      size="sm"
      class="turn-meta h-auto w-fit items-center justify-start gap-2.5 self-start px-1 py-1 font-sans text-[length:var(--text-sm)] font-medium transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
      :class="[
        !turn.hasFoldable
          ? 'cursor-default hover:text-neutral-mid'
          : 'cursor-pointer hover:text-neutral-fg',
      ]"
      :disabled="sessionActive || !turn.hasFoldable"
      @click="toggle(turnIndex)"
    >
      <!-- streaming 态：spinner（更显眼的流式生成指示），替代原脉冲点。仅文本流式生成时转（A 类） -->
      <Loader2 v-if="isStreaming" class="size-3 shrink-0 animate-spin text-accent" />
      <span class="text-[length:var(--text-sm)] font-medium">
        <span class="lbl" :class="sessionActive ? 'text-accent' : 'text-neutral-mid'">{{ sessionActive ? t('panel.message.thinking') : t('panel.message.worked') }}</span>
        <span class="elapsed font-mono font-medium tracking-[0.01em] text-neutral-fg">{{ elapsed }}</span>
      </span>
      <!-- chevron 紧跟耗时（展开/收起 trace 入口），在 badge 之前 -->
      <ChevronRight
        v-if="turn.hasFoldable && !sessionActive"
        class="chev size-[9px] text-neutral-dim transition-transform duration-[var(--duration)] ease-[var(--ease)]"
        :class="isExpanded(turnIndex) ? 'rotate-90 text-accent' : ''"
      />
      <!-- H 设计 badge 灰阶化：bg-surface-2 text-neutral-mid 替代 bg-reasoning-soft/bg-info-soft -->
      <span v-if="thinkCount > 0" class="badge badge-think inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 font-mono text-[length:var(--text-2xs)] font-semibold tracking-[0.02em] text-neutral-mid">
        <Brain class="size-2.5" />{{ t('panel.message.thinkCount', { count: thinkCount }) }}
      </span>
      <span v-if="toolCount > 0" class="badge badge-tool inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 font-mono text-[length:var(--text-2xs)] font-semibold tracking-[0.02em] text-neutral-mid">
        <Wrench class="size-2.5" />{{ t('panel.message.toolCount', { count: toolCount }) }}
      </span>
    </Button>
    <hr class="border-0 border-t border-border" />
  </div>
</template>

<script setup lang="ts">
import { Brain, ChevronRight, Loader2, Wrench } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import { useChatViewDeps } from './chat-view-deps'

defineProps<{
  turn: MessageTurn
  sessionActive: boolean
  isStreaming: boolean
  thinkCount: number
  toolCount: number
  elapsed: string
  /** 当前 turn 在 session 内的序列下标（turn expansion key） */
  turnIndex: number
  /** session id（透传保留） */
  sessionId: string
}>()

// turn 展开/折叠经 ChatViewDeps inject（renderer 壳绑 useTurnExpansion store）
const { isExpanded, toggleExpand: toggle } = useChatViewDeps()

const { t } = useI18n()
</script>
