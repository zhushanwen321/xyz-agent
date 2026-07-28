<template>
  <!--
    subagent 块（@zhushanwen/pi-subagent-workflow，重写 fork）。
    异步 background 执行：只展示发起参数（input），看不到执行过程（结果由 agent 后续 turn 总结）。
    标题行：subagent + agent + · + slug + (model · thinking X)
    第二行：task 首行预览（截断 60）
    展开体：task 完整内容 + background 状态行
    视觉（demo h）：左缩进 14px + 底部 dashed 分割 + subagent prefix tag（统一 uppercase-mono，无装饰点）
  -->
  <div class="trace-subagent border-b border-dashed border-border pl-3.5 pb-2.5 mb-0.5" data-testid="subagent-block">
    <div
      class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[length:var(--text-base)] font-medium transition-opacity hover:opacity-80"
      :class="subagentHeaderColor"
      :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
      @click="toggleTool"
    >
      <ChevronRight
        class="size-[14px] shrink-0 transition-transform text-neutral-dim"
        :class="toolExpanded ? 'rotate-90 text-accent' : ''"
      />
      <!-- running 态 loader（双环 + accent），其余走 users ICON -->
      <span v-if="isRunning" class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" /> <!-- eslint-disable-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
      <component
        :is="BLOCK_ICON_LUCIDE.subagent"
        v-else
        class="size-[13px] shrink-0 text-neutral-ico hover:text-neutral-ico-hover"
        :class="isFailed ? 'hover:text-warn' : ''"
      />
      <span class="mr-0.5 inline-block shrink-0 whitespace-nowrap font-mono text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.08em] text-neutral-fg">subagent</span>
      <span class="shrink-0 whitespace-nowrap font-mono text-[length:var(--text-sm)] text-accent">{{ subagentAgent }}</span>
      <template v-if="subagentSlug">
        <span class="text-neutral-faint">·</span>
        <span class="shrink-0 whitespace-nowrap font-mono text-[length:var(--text-sm)] text-accent">{{ subagentSlug }}</span>
      </template>
      <!-- model + thinkingLevel（仅当 model 存在时显示括号；thinkingLevel 仅当存在时追加） -->
      <template v-if="subagentModel">
        <span class="text-neutral-dim font-mono text-[length:var(--text-xs)]">&nbsp;(</span>
        <span class="font-mono text-[length:var(--text-xs)] text-accent">{{ subagentModel }}</span>
        <span v-if="subagentThinkingLevel" class="text-neutral-dim font-mono text-[length:var(--text-xs)]">&nbsp;· thinking {{ subagentThinkingLevel }})</span>
        <span v-else class="text-neutral-dim font-mono text-[length:var(--text-xs)]">)</span>
      </template>
      <!-- 终态指示：完成（Check）/ 未收到结果（CircleDashed + text）。failed 不加额外标记（维持现状）。
           unfinished 用 text-neutral-mid（6.78:1 过 AA），不用 dim（3.56:1 不过 AA，critique 第 3 轮）。
           CircleDashed（中性灰，非 Check 非 warn）表达"状态不确定/未收到"。 -->
      <Check v-if="!isFailed && !isRunning && !isUnfinished" class="ml-0.5 size-3 shrink-0 text-neutral-mid" />
      <template v-else-if="isUnfinished">
        <CircleDashed class="ml-0.5 size-3 shrink-0 text-neutral-mid" />
        <span class="ml-0.5 whitespace-nowrap text-neutral-mid">{{ t('panel.message.noResult') }}</span>
      </template>
    </div>
    <!-- task 首行预览（收起态可见，dim） -->
    <div v-if="subagentTaskPreview" class="mt-0.5 pl-5 truncate text-[length:var(--text-sm)] text-neutral-dim">
      {{ subagentTaskPreview }}
    </div>
    <template v-if="toolExpanded">
      <!-- 展开体：task 完整内容 + background 状态行（异步执行看不到过程） -->
      <div v-if="subagentTask || bgStatusText" class="group/result relative mt-1">
        <Button
          v-if="subagentTask"
          variant="ghost"
          size="icon"
          class="absolute top-0 left-0 size-5 rounded-sm text-neutral-dim opacity-0 transition-opacity hover:text-neutral-fg group-hover/result:opacity-100"
          :title="t('panel.message.copy')"
          @click.stop="copy(subagentTask, `subagent-${tool.id}`)"
        >
          <Check v-if="copied === `subagent-${tool.id}`" class="size-3 text-success" />
          <CopyIcon v-else class="size-3" />
        </Button>
        <!-- task 完整内容（无标题，surface-2 代码块样式，pre-wrap 保留换行） -->
        <div
          v-if="subagentTask"
          class="subagent-task-full ml-5 whitespace-pre-wrap rounded-sm border border-border bg-surface-2 px-2.5 py-1.5 text-[length:var(--text-sm)] leading-[1.65] text-neutral-mid"
        >{{ subagentTask }}</div>
        <!-- background 状态行（来自 output.bgResponse，带状态点 blink 动画） -->
        <div
          v-if="bgStatusText"
          class="ml-5 mt-1.5 flex items-center gap-2 rounded-sm border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[length:var(--text-xs)] text-neutral-dim"
        >
          <span class="inline-block size-1.5 animate-blink rounded-full bg-accent"></span>
          background · {{ bgStatusText }}
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy as CopyIcon, ChevronRight, Check, CircleDashed } from '@lucide/vue'
import type { ToolCall } from '@xyz-agent/shared'
import { BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG } from './block-icon'
import { Button } from '@/components/ui/button'
import { useCopy } from '@/composables/effects/useCopy'

const { t } = useI18n()
const { copied, copy } = useCopy()

const props = defineProps<{
  tool: ToolCall
  /** 所属 session（透传保留，当前 subagent 渲染未直接使用，向后兼容/未来扩展） */
  sessionId?: string | null
}>()

const isFailed = computed(() => props.tool.status === 'error')
const isRunning = computed(() => props.tool.status === 'running')
/** 流结束未收到 tool_call_end（进程崩溃/WS 断连/event-adapter 乱序丢消息）。
 *  诚实态，区别于 running（实时进行中）和 error（明确失败）——未收到结果不代表失败。 */
const isUnfinished = computed(() => props.tool.status === 'end_not_received')

/** tool 折叠：默认收起，仅 failed 强制展开（错误须直视，不可收起）。 */
const toolCollapsed = ref(true)
const toolExpanded = computed(() => isFailed.value || !toolCollapsed.value)

function toggleTool(): void {
  toolCollapsed.value = !toolCollapsed.value
}

/** Demo H：subagent header 色——failed 中性灰，其余中性 fg（去 reasoning 紫）。
 *  running 由 loader + accent 文案表达，header 整体仍中性。 */
const subagentHeaderColor = computed(() => (isFailed.value ? 'text-neutral-mid' : 'text-neutral-fg'))

/** 顶层 input 安全读取。
 *  拍平 schema：action / agent / slug / model / thinkingLevel / task 都在顶层（非 startParam 嵌套）。 */
const inputObj = computed<Record<string, unknown>>(() => {
  const input = props.tool.input
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
})

/** agent 名（顶层 input.agent，默认 general-purpose）。 */
const subagentAgent = computed(() => {
  const agent = inputObj.value.agent
  return typeof agent === 'string' && agent.trim() ? agent : 'general-purpose'
})

/** slug（顶层 input.slug，短标签，≤35 字符）。 */
const subagentSlug = computed(() => {
  const slug = inputObj.value.slug
  return typeof slug === 'string' ? slug.trim() : ''
})

/** model override（顶层 input.model，provider/modelId 格式）。 */
const subagentModel = computed(() => {
  const model = inputObj.value.model
  return typeof model === 'string' && model.trim() ? model : ''
})

/** thinkingLevel（off/minimal/low/medium/high/xhigh）。 */
const subagentThinkingLevel = computed(() => {
  const level = inputObj.value.thinkingLevel
  return typeof level === 'string' && level.trim() ? level : ''
})

/** task 完整内容（顶层 input.task，长 prompt）。 */
const subagentTask = computed(() => {
  const task = inputObj.value.task
  return typeof task === 'string' ? task : ''
})

/** task 首行预览截断长度（header 单行不撑爆；task 常含换行只取首行）。 */
const TASK_PREVIEW_LIMIT = 60

/** header 行 task 预览：取首个非空行，截断 60 字符。 */
const subagentTaskPreview = computed(() => {
  const firstLine = subagentTask.value.split('\n').find((l) => l.trim())?.trim() ?? ''
  if (firstLine.length <= TASK_PREVIEW_LIMIT) return firstLine
  return `${firstLine.slice(0, TASK_PREVIEW_LIMIT)}…`
})

/** output 解析（JSON 字符串 → bgResponse）。
 *  真实 output 形态：{ action, subagentId, sessionFile, slug, bgResponse: { status, mode, message } } */
const bgResponse = computed<{ status?: string; message?: string } | null>(() => {
  const raw = props.tool.output?.trim()
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && 'bgResponse' in data) {
      const bg = (data as Record<string, unknown>).bgResponse
      if (bg && typeof bg === 'object') {
        return bg as { status?: string; message?: string }
      }
    }
  } catch (err) {
    // output 非合法 JSON（纯文本结果或空串），降级为无 background 状态行。
    // 这是预期分支而非错误——subagent 结果可能是任意文本，不强制 JSON。
    void err
  }
  return null
})

/** background 状态文案（优先取 bgResponse.message，running 时回退默认文案）。 */
const bgStatusText = computed(() => {
  if (bgResponse.value?.message) return bgResponse.value.message
  if (bgResponse.value?.status === 'running') return 'running detached · will notify on completion'
  return ''
})
</script>

<style scoped>
/* background 状态点用 animate-blink（tailwind.config 内置），无需自定义 keyframes */
</style>
