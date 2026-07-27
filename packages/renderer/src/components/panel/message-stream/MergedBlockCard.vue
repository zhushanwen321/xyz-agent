<template>
  <!--
    展示组件 · merged 卡片（w3 wave · 灰阶版）。
    连续同类 thinking/tool 块合并后的可展开卡片：header 汇总文案 + 展开后 items 列表。
    从 Turn.vue 抽出（保持 Turn.vue ≤500 行 eslint max-lines 规范）。

    样式（§13.2-B 灰阶）：border-l-2 border-neutral-faint + bg-transparent + hover:bg-surface-2。
    类型仅靠 icon 区分（tool→Wrench / thinking→Lightbulb），无彩色语义标签。
    expanded 态本地管理（merged 卡是 trace 内次级折叠，与 turn 级 rail toggle 语义不同）。
  -->
  <div
    class="merged-card my-1 rounded-md border-l-2 border-neutral-faint bg-transparent px-2 py-1 transition-colors hover:bg-surface-2"
    role="button"
    tabindex="0"
    data-testid="merged-block-card"
    :aria-expanded="expanded"
  >
    <div
      data-testid="merged-block-card-header"
      class="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-neutral-mid transition-colors hover:text-neutral-fg"
      @click="expanded = !expanded"
      @keydown.enter.prevent="expanded = !expanded"
      @keydown.space.prevent="expanded = !expanded"
    >
      <ChevronRight
        class="size-3 shrink-0 text-neutral-mid transition-transform"
        :class="expanded ? 'rotate-90 text-accent' : ''"
      />
      <component :is="headerIcon" class="size-[13px] shrink-0 text-neutral-ico transition-colors hover:text-neutral-ico-hover" />
      <span class="normal-case tracking-normal">{{ summary }}</span>
    </div>
    <!-- 展开后：items 列表（每个 item 渲染独立 Block） -->
    <div v-if="expanded" class="mt-1 flex flex-col gap-0.5 select-text">
      <Block
        v-for="(item, iIdx) in blk.items"
        :key="`${blk.type}-${iIdx}`"
        :type="item.kind"
        :content="item.kind === 'thinking' ? (item.ref as ThinkingBlock).content : undefined"
        :tool="item.kind === 'tool' ? (item.ref as ToolCall) : undefined"
        :thinking-id="item.kind === 'thinking' ? (item.ref as ThinkingBlock).id : undefined"
        :collapsed="item.kind === 'thinking' ? (item.ref as ThinkingBlock).collapsed : undefined"
        :working="working"
        :session-id="sessionId"
        :force-expand="true"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * script：本地 expanded 态 + 汇总文案（i18n tool/thinking 按 items 数）+ 灰阶 icon 决策。
 * 无副作用，纯展示 + 本地折叠态。icon 走 block-icon.ts 的 BLOCK_ICON_LUCIDE
 * （tool→tool-other=Wrench / thinking→Lightbulb），与 Block.vue icon 体系一致。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import type { MergedBlockGroup } from '@/composables/logic/mergeBlocks'
import type { ThinkingBlock, ToolCall } from '@xyz-agent/shared'
import Block from './Block.vue'
import { BLOCK_ICON_LUCIDE } from './block-icon'

const props = defineProps<{
  /** 合并组（连续同类 thinking/tool，items.length >= 2） */
  blk: MergedBlockGroup
  /** 父 turn 是否进行中（透传给内部 Block 的 working prop） */
  working: boolean
  /** session id（透传给内部 Block） */
  sessionId: string
}>()

const { t } = useI18n()

/** 本地展开态（merged 卡次级折叠，不进 useTurnExpansion）。working 时默认展开，流式可见。 */
const expanded = ref(props.working)
watch(
  () => props.working,
  (w) => {
    if (w) expanded.value = true
  },
)

/** 汇总文案：tool 用 mergedTools i18n，thinking 用 mergedThoughts（文案保留不变） */
const summary = computed(() =>
  props.blk.type === 'tool'
    ? t('panel.message.mergedTools', { n: props.blk.items.length })
    : t('panel.message.mergedThoughts', { n: props.blk.items.length }),
)

/** header icon：tool→BLOCK_ICON_LUCIDE['tool-other']=Wrench，thinking→BLOCK_ICON_LUCIDE.thinking=Lightbulb。
 *  与 Block.vue 单块 icon 决策一致（§13.2-B / §13.3：merged 卡传入合成 block type，icon 走同一映射）。 */
const headerIcon = computed(() =>
  props.blk.type === 'tool' ? BLOCK_ICON_LUCIDE['tool-other'] : BLOCK_ICON_LUCIDE.thinking,
)
</script>
