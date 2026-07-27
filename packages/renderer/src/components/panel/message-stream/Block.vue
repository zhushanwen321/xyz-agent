<template>
  <!--
    展示组件 · trace 块（message-stream 折叠区内的单个块）。Demo H 视觉：灰阶 + SVG ICON +
    唯一 accent 蓝（running）+ failed hover muted 暖橙。
    - thinking：lightbulb ICON + header 可点击 toggle，长块独立再折叠（本地折叠态）。
    - tool：默认 1 行收起（streaming/running 也收起），点击展开详情。仅 failed 强制展开。
    - workflow：list-checks ICON + WORKFLOW. prefix + 状态动词 + workflow 名，详情区走 list-tree GUI / 文本。
    - subagent：渲染委托给 BlockSubagent（users ICON + SUBAGENT. prefix + 去卡片化）。
    - failed：无鲜红全展开（红框已删），改中性灰默认 + hover 染 warn，错误摘要进 body 文本。
    审批按钮 DEFERRED（G-018），v1 不渲染。failed 救生按钮不做（agent 自处理，design.md 决策 3）。
  -->
  <div class="trace-blk py-2" :class="blockClass" :data-testid="testId">
    <!-- thinking 块：header 可点击 toggle，长 reasoning 独立再折叠（本地折叠态，由 collapsed prop 初始化） -->
    <div v-if="type === 'thinking'" class="trace-think">
      <!--
        flex 两段式（P0-2 方案 B）：header 独占一行（chevron + icon + label + 收起态 preview），
        展开体作为 block 在下一行渲染（pl-6 与 icon 对齐）。与 tool/subagent/workflow 展开体一致，
        避免 MarkdownRenderer 输出 <p> block 元素进 inline-block 容器导致强制换行。
      -->
      <div
        class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[12.5px] font-medium text-neutral-mid transition-colors hover:text-neutral-fg"
        :title="thinkingExpanded ? t('panel.message.collapseReasoning') : t('panel.message.expandReasoning')"
        @click="toggleThinking"
      >
        <ChevronRight class="size-[14px] shrink-0 transition-transform text-neutral-dim" :class="thinkingExpanded ? 'rotate-90 text-accent' : ''" />
        <component :is="BLOCK_ICON_LUCIDE.thinking" class="size-[13px] shrink-0 text-neutral-ico hover:text-neutral-ico-hover" />
        <span class="shrink-0">{{ t('panel.message.thinkingBlock') }}</span>
        <!-- 收起态：preview 跟在 label 后（truncate 避免长 preview 撑爆） -->
        <span v-if="!thinkingExpanded" class="min-w-0 truncate text-neutral-dim">· {{ previewText }}</span>
      </div>
      <!-- 展开态：block 在下一行，pl-6 与 icon 右侧对齐；copy 按钮在左上角（hover 显） -->
      <div v-if="thinkingExpanded" class="group/think relative mt-1 text-[12px] leading-relaxed">
        <Button
          variant="ghost"
          size="icon"
          class="absolute top-0 left-0 size-5 rounded-sm text-neutral-dim opacity-0 transition-opacity hover:text-neutral-fg group-hover/think:opacity-100"
          :title="t('panel.message.copy')"
          @click.stop="content && copy(content, `thinking-${thinkingId ?? 'block'}`)"
        >
          <Check v-if="copied === `thinking-${thinkingId ?? 'block'}`" class="size-3 text-success" />
          <CopyIcon v-else class="size-3" />
        </Button>
        <div class="pl-6 select-text text-neutral-mid">
          <MarkdownRenderer v-if="!working" :content="content ?? ''" :session-id="sessionId ?? undefined" variant="thinking" />
          <span v-else>{{ previewText }}</span>
        </div>
      </div>
    </div>

    <!-- 中间产出 text 块（draft §4 Output Text 中间：折进执行流程，下划线行，markdown 渲染）。
         streaming 光标已移到 Turn.vue trace 末尾（保证永远在最后一行，不受 contentBlocks 时序影响）。 -->
    <div v-else-if="type === 'text'" class="border-b border-dashed border-border pb-2 text-[12px] leading-relaxed text-neutral-mid">
      <MarkdownRenderer :content="content ?? ''" :session-id="sessionId ?? undefined" />
    </div>

    <!-- tool_call 块：默认 1 行收起（streaming/running 也收起），header 含摘要，点击展开详情。
         subagent（pi-subagents 的 "subagent" tool）渲染委托给 BlockSubagent（独立样式：users ICON +
         SUBAGENT. prefix + 去卡片化）——subagent 逻辑已抽离到 BlockSubagent.vue。
         workflow（pi-workflow 的 "workflow" tool）：list-checks ICON + WORKFLOW. prefix + list-tree GUI。
         HIDDEN_TOOL_NAMES（todo/goal_control 等状态管理类 tool）直接跳过——状态由 SideDrawer Tasks tab 展示。 -->
    <div v-else-if="!isHidden" class="trace-tool">
      <!-- ── subagent 块：委托 BlockSubagent ── -->
      <BlockSubagent v-if="isSubagent" :tool="tool!" :session-id="sessionId" />

      <!-- ── workflow 块：list-checks ICON + WORKFLOW. prefix + 状态动词 + workflow 名 ── -->
      <div v-else-if="isWorkflow" class="trace-workflow" data-testid="workflow-block">
        <div
          data-testid="tool-block-header"
          class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[13px] font-medium text-neutral-fg transition-opacity hover:opacity-80"
          :class="workflowStatusClass"
          :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
          @click="toggleTool"
        >
          <ChevronRight class="size-[14px] shrink-0 transition-transform text-neutral-dim" :class="toolExpanded ? 'rotate-90 text-accent' : ''" />
          <!-- running 态 loader（双环 + accent），其余走 list-checks ICON -->
          <span v-if="isRunning" class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" /> <!-- eslint-disable-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
          <component :is="BLOCK_ICON_LUCIDE.workflow" v-else class="size-[13px] shrink-0 text-neutral-ico hover:text-neutral-ico-hover" :class="isFailed ? 'hover:text-warn' : ''" />
          <span class="workflow-tag shrink-0 whitespace-nowrap uppercase tracking-[0.08em] font-semibold text-[12px] text-neutral-fg font-mono">{{ t('panel.message.workflow') }}</span>
          <span class="shrink-0 whitespace-nowrap">{{ workflowStatusText }}</span>
          <span class="min-w-0 truncate text-neutral-dim">· {{ workflowName }}</span>
        </div>
        <template v-if="toolExpanded">
          <!-- workflow 详情区：copy 按钮在左上角 -->
          <div v-if="result" class="group/result relative mt-1 text-[12px] leading-snug text-neutral-mid select-text">
            <Button
              variant="ghost"
              size="icon"
              class="absolute top-0 left-0 size-5 rounded-sm text-neutral-dim opacity-0 transition-opacity hover:text-neutral-fg group-hover/result:opacity-100"
              :title="t('panel.message.copy')"
              @click.stop="copy(result, `tool-${tool!.id}`)"
            >
              <Check v-if="copied === `tool-${tool!.id}`" class="size-3 text-success" />
              <CopyIcon v-else class="size-3" />
            </Button>
            <div class="pl-6">
              <GuiComponentRenderer v-if="guiComponent" :component="guiComponent" />
              <AnsiText v-else-if="outputRaw" :content="outputRaw" />
              <span v-else class="whitespace-pre-wrap">{{ result }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- ── 普通 tool 块：1 行收起（header 含 toolName+argPath 摘要+状态），点击展开详情 ── -->
      <div v-else>
        <div
          data-testid="tool-block-header"
          class="tool-header flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[12.5px] font-medium transition-opacity hover:opacity-80"
          :class="toolStatusClass"
          :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
          @click="toggleTool"
        >
          <ChevronRight class="size-[14px] shrink-0 transition-transform text-neutral-dim" :class="toolExpanded ? 'rotate-90 text-accent' : ''" />
          <!-- running 态 loader（双环 + accent），其余走 BLOCK_ICON_LUCIDE[iconKind] -->
          <span v-if="isRunning" class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" /> <!-- eslint-disable-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
          <component :is="headerBlockIcon" v-else class="size-[13px] shrink-0 text-neutral-ico hover:text-neutral-ico-hover" :class="isFailed ? 'hover:text-warn' : ''" />
          <span class="shrink-0 normal-case tracking-normal">{{ toolName }}</span>
          <span v-if="argPath" class="min-w-0 normal-case tracking-normal text-neutral-dim truncate">· {{ argPath }}</span>
          <!-- 状态指示：completed 显 Check（中性），failed 由 AlertTriangle 表达不重复，running 由 loader 表达 -->
          <Check v-if="!isFailed && !isRunning && !isUnfinished && result" class="ml-0.5 size-3 shrink-0 text-neutral-mid" />
          <span v-else-if="isUnfinished" class="ml-0.5 normal-case tracking-normal text-neutral-dim whitespace-nowrap">{{ t('panel.message.noResult') }}</span>
          <Button
            v-if="isBash && !isRunning && sessionId"
            variant="ghost"
            size="icon"
            data-testid="tool-run-in-terminal"
            class="ml-auto size-5 shrink-0 rounded-sm p-0 text-neutral-dim hover:text-accent"
            :title="t('panel.terminal.runInTerminal')"
            @click.stop="runInTerminal"
          >
            <TerminalIcon class="size-3" />
          </Button>
        </div>
        <template v-if="toolExpanded">
          <!-- 补充细节条：失败错误摘要 + 行数/字符数 + 耗时。对齐 subagent 展开体信息架构 -->
          <div v-if="metaItems.length" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <span
              v-for="(item, idx) in metaItems"
              :key="idx"
              :class="{
                'text-neutral-mid font-semibold': item.tone === 'danger',
                'text-neutral-mid': item.tone === 'info',
                'text-neutral-dim': item.tone === 'muted',
              }"
            >{{ item.text }}</span>
          </div>
          <!-- 结果区：左上角 action 组（copy 始终在；failed+bash 时加「在终端运行」recovery），hover 显示 -->
          <div v-if="result" class="group/result relative mt-1">
            <div class="absolute top-0 left-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/result:opacity-100">
              <Button
                variant="ghost"
                size="icon"
                class="size-5 rounded-sm text-neutral-dim hover:text-neutral-fg"
                :title="t('panel.message.copy')"
                @click.stop="copy(result, `tool-${tool!.id}`)"
              >
                <Check v-if="copied === `tool-${tool!.id}`" class="size-3 text-success" />
                <CopyIcon v-else class="size-3" />
              </Button>
              <Button
                v-if="isFailed && isBash && sessionId"
                variant="ghost"
                size="icon"
                data-testid="tool-failed-run-in-terminal"
                class="size-5 rounded-sm text-neutral-dim hover:text-warn"
                :title="t('panel.terminal.runInTerminal')"
                @click.stop="runInTerminal"
              >
                <TerminalIcon class="size-3" />
              </Button>
            </div>
            <div
              class="tool-result font-mono text-[12px] leading-snug whitespace-pre-wrap border-l-2 border-neutral-faint pl-6 select-text"
              :class="isFailed ? 'text-neutral-mid hover:border-warn hover:text-neutral-fg' : 'text-neutral-mid'"
            >
              <GuiComponentRenderer v-if="guiComponent" :component="guiComponent" />
              <AnsiText v-else-if="outputRaw" :content="outputRaw" />
              <span v-else>{{ result }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy as CopyIcon, Terminal as TerminalIcon } from '@lucide/vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { extractGui } from '@xyz-agent/extension-protocol'
import type { ToolCall } from '@xyz-agent/shared'
import { SUBAGENT_TOOL_NAMES, HIDDEN_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '@xyz-agent/shared'
import AnsiText from './gui/AnsiText.vue'
import GuiComponentRenderer from './GuiComponentRenderer.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import BlockSubagent from './BlockSubagent.vue'
import { BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG, getBlockIcon } from './block-icon'
import { formatDuration } from './format-utils'
import { Button } from '@/components/ui/button'
import { useRunInTerminal } from '@/composables/panel/useRunInTerminal'
import { useToolMeta } from '@/composables/panel/useToolMeta'
import { useCopy } from '@/composables/effects/useCopy'

const { t } = useI18n()
const { copied, copy } = useCopy()

const props = defineProps<{
  type: 'thinking' | 'tool' | 'text' | 'agentgraph'
  /** thinking / text 内容 */
  content?: string
  /** thinking 块 id（thinking 类型时由父组件透传，用于 data-testid 精确锚定；其他类型忽略） */
  thinkingId?: string
  /** tool_call 数据（type==='tool' 时必填） */
  tool?: ToolCall
  /** thinking 块初始折叠态（来自 ThinkingBlock.collapsed，默认收起） */
  collapsed?: boolean
  /** working 态（turn 进行中）：thinking 强制全展开且不可手动收（draft §1 无背景下划线展开）。
   *  tool 块不再因 working 强制展开（改后 streaming 态也 1 行收起，header 自带状态指示）。 */
  working?: boolean
  /** @deprecated streaming 光标已移到 Turn.vue trace 末尾独立元素（streaming-tail），
   *  保证永远在最后一行。此 prop 保留向后兼容，不再被驱动（Turn.vue 不再传入 true）。 */
  streaming?: boolean
  /** 所属 session（透传给 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
  /** 强制展开（merged 卡片场景：外层已折叠，内层 Block 不应再各自收起）。
   *  true 时 thinking/tool 强制展开且不可手动收，与 working 态语义一致但独立于 working
   *  （working 绑定 session 进行中，forceExpand 绑定外层折叠容器展开）。 */
  forceExpand?: boolean
}>()

/* ── thinking 折叠：working 态强制展开且不可收（draft §1）；非 working 由本地态 toggle ── */
const thinkingCollapsed = ref(props.collapsed ?? true)
const thinkingExpanded = computed(() => props.working || props.forceExpand || !thinkingCollapsed.value)

function toggleThinking(): void {
  if (props.working || props.forceExpand) return
  thinkingCollapsed.value = !thinkingCollapsed.value
}

/** 收起态的正文预览（截断，draft：收起时显一行摘要） */
const PREVIEW_LIMIT = 60
const previewText = computed(() => {
  const c = props.content?.trim() ?? ''
  if (c.length <= PREVIEW_LIMIT) return c
  return `${c.slice(0, PREVIEW_LIMIT)}…`
})

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')
/** 流结束未收到 tool_call_end（进程崩溃/WS 断连/event-adapter 乱序丢消息）。
 *  诚实态，区别于 running（实时进行中）和 error（明确失败）——未收到结果不代表失败。 */
const isUnfinished = computed(() => props.tool?.status === 'end_not_received')
const toolName = computed(() => props.tool?.toolName ?? 'tool')
const result = computed(() => props.tool?.output)
/** 原始 ANSI 文本（未经 stripAnsi）。有此字段时用 AnsiText 渲染着色，无则回退 output 纯文本。 */
const outputRaw = computed(() => props.tool?.outputRaw)

/** 补充细节条 meta 项（耗时 + 工具特化行数/字符数 + 失败错误摘要），逻辑拆到 useToolMeta */
const { metaItems } = useToolMeta({
  tool: computed(() => props.tool),
  toolName,
  isFailed,
  formatDuration,
})

/* ── 块类型路由：subagent / workflow / hidden ── */
const isSubagent = computed(() => SUBAGENT_TOOL_NAMES.has(toolName.value))
const isWorkflow = computed(() => WORKFLOW_TOOL_NAMES.has(toolName.value))
/** 状态管理类 tool（todo/goal_control）：对话流完全不渲染（v-else-if=!isHidden 跳过）。
 *  其状态变化由 SideDrawer Tasks tab 展示。仅影响渲染层，数据仍完整存储。 */
const isHidden = computed(() => !isSubagent.value && HIDDEN_TOOL_NAMES.has(toolName.value))

/** 普通 tool header 的块类型 ICON（running 用 loader，其余走 BLOCK_ICON_LUCIDE） */
const headerBlockIcon = computed(() => {
  const kind = getBlockIcon(toolName.value, props.tool?.status ?? 'completed', false, false)
  // running 态走模板的 loader 分支（v-if isRunning），不走此 computed
  return kind === 'running' ? BLOCK_ICON_LUCIDE['tool-other'] : BLOCK_ICON_LUCIDE[kind]
})

/** 普通 tool header 状态色：running 染 accent，failed/unfinished 中性灰，completed 中性 */
const toolStatusClass = computed(() => {
  if (isRunning.value) return 'text-accent'
  if (isFailed.value) return 'text-neutral-mid'
  if (isUnfinished.value) return 'text-neutral-dim'
  return 'text-neutral-fg'
})

/** workflow 状态动词（Done/Running/Failed）+ header 色 */
const workflowStatusText = computed(() => {
  if (isRunning.value) return t('panel.message.workflowRunning')
  if (isFailed.value) return t('panel.message.workflowFailed')
  return t('panel.message.workflowDone')
})
const workflowStatusClass = computed(() => {
  if (isRunning.value) return 'text-accent'
  return ''
})

/** workflow 名（从 input.name 提取，pi-workflow 的 workflow tool input 含 name 字段） */
const workflowName = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (input && typeof input.name === 'string') return input.name
  return toolName.value
})

/**
 * 从 tool.details.__gui__ 提取结构化渲染组件（extension GUI 协议，spec §9.1）。
 * extension RPC 模式把 GuiComponent 放进 details.__gui__.component，前端用 extractGui
 * 统一校验版本后路由到 GuiComponentRenderer。无 __gui__ 时 undefined（走 AnsiText/纯文本兜底）。
 * 注：ToolCall 的结构化扩展数据存在 details 字段（pi tool_execution_end result.details）。
 *
 * streaming __gui__ 仅在 running 态有效——tool_call_end 后若 details 无 __gui__，
 * 不应回退到过期的 streaming detail（如 extension streaming 推了进度组件但最终返回纯文本）。
 * 否则已完成工具会错误显示 streaming 过程中的临时 GUI 组件。
 */
const guiComponent = computed<GuiComponent | undefined>(() => {
  // tool_call_end 的 details（复数，最终态）优先
  const fromEnd = extractGui(props.tool?.details)?.component
  if (fromEnd) return fromEnd
  // streaming 态 fallback：仅在 tool 仍在 running 时用 detail（单数）。
  // tool_call_end 后 detail 残留不应被当作渲染源（最终态无 __gui__ → 不渲染 GUI 组件）。
  if (isRunning.value) {
    const streamingDetail = props.tool?.detail
    if (typeof streamingDetail === 'object' && streamingDetail !== null) {
      return extractGui(streamingDetail)?.component
    }
  }
  return undefined
})

/**
 * tool 折叠：默认 1 行收起（含 streaming/running 态——改前 working/running 强制展开，
 * 改后 header 行已含摘要+状态指示，1 行即可观察进度，点击才展开详情）。
 * 仅 failed 强制展开（错误须直视，不可收起）。
 */
const toolCollapsed = ref(true)
const toolExpanded = computed(() => isFailed.value || props.forceExpand || !toolCollapsed.value)

function toggleTool(): void {
  if (props.forceExpand) return
  toolCollapsed.value = !toolCollapsed.value
}

/**
 * 从 input 提取可读参数摘要（header 单行展示）。覆盖高频工具：
 * bash→command、read/write/edit→path、grep→pattern、todo_write→tasks 数量等。
 * 未覆盖的工具返回空串（header 只显 toolName）。
 */
const argPath = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.path === 'string') return input.path
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.pattern === 'string') return input.pattern
  if (Array.isArray(input.tasks)) return `${input.tasks.length} todos`
  return ''
})

// Phase 5 联动 2：bash 工具块「在终端运行」按钮（isBash + runInTerminal 从 useRunInTerminal 拆出）
const { isBash, runInTerminal } = useRunInTerminal({
  toolName,
  argPath,
  sessionId: computed(() => props.sessionId),
  isRunning,
})

/** Demo H：failed 红框已删（blockClass 不再返回 border-danger/bg-danger-soft）。
 *  failed 块改中性灰默认 + hover 染 warn（scoped .tool-header / .tool-result hover 处理）。
 *  保留 blockClass 钩子以备未来整体块级视觉（如 running 高亮条），当前返回空串。 */
const blockClass = computed(() => '')

/** data-testid 锚点：按块类型拼接可定位 id，供 E2E 精确断言特定块。
 *  格式：block-tool-${tool.id}（type==='tool'/'agentgraph' 且有 tool）/ block-thinking-${thinkingId}（type==='thinking'）。
 *  agentgraph（subagent/workflow）数据结构同 tool（ToolCall 有 id），故共用 block-tool 前缀。
 *  无 id（text / thinking 无 id）时回退 undefined（不输出 data-testid 属性，避免污染选择器）。 */
const testId = computed(() => {
  if (props.type === 'tool' || props.type === 'agentgraph') {
    const id = props.tool?.id
    return id ? `block-tool-${id}` : undefined
  }
  if (props.type === 'thinking') {
    return props.thinkingId ? `block-thinking-${props.thinkingId}` : undefined
  }
  return undefined
})
</script>

<style scoped>
/* Demo H 去卡片化：workflow-tag ::after accent 蓝点。
   Tailwind 无法表达 ::after content，走 scoped style（三层结构 escape hatch）。 */
.workflow-tag::after {
  content: '';
  display: inline-block;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
  margin-left: 5px;
  vertical-align: middle;
}
</style>
