<script setup lang="ts">
/**
 * AskUserOverlay —— ask-user extension 的富交互渲染组件（W2 inline 版）。
 *
 * askUserInteract() 通过 select 通道携带 AskUserQuestion[] 数据，
 * runtime event-adapter 检测 ASK_USER_MARKER 后透传 questions 数据到 extension.ui_request。
 * W2 起 Panel.vue 直接 inline 挂载此组件（覆盖 composer 位置），不再经 ExtensionUIDialog modal 包裹。
 *
 * 交互能力（对齐 TUI 版 AskUserComponent）：
 * - tab 切换（多问题来回修改）
 * - 单选 / 多选
 * - Other 自由文本（选项末尾追加输入框）
 * - comment 附加评论
 * - Submit 汇总提交 / Cancel 取消
 *
 * answers 格式（ask-user/types.ts AskUserAnswers）：
 * - 单选：value = 选中项 value string
 * - 多选：value = JSON.stringify(value[])
 * - Other：独立 key `${header}__other`
 * - comment：独立 key `${header}__comment`
 *
 * 样式对齐 demo v2（docs/page-design/v3/ask-user/inline-ask-user-demo.html）：
 * - 字体统一：tab(非选中) / 标题 / 选项 label 均 text-[13px] font-normal，选中态 tab font-medium + accent 下划线
 * - description 弱化：opt-desc 同字号 text-[13px]、muted 色建立层级
 * - 请求头 ask-user-head：脉冲圆点 + 标识 + 右上倒计时（5min 超时，warning 色，Clock 图标）
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { Clock } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import type { AskUserQuestion, AskUserOption } from '@xyz-agent/extension-protocol'

const props = withDefaults(defineProps<{
  questions: AskUserQuestion[]
  allowCancel?: boolean
  /** 请求到达时间戳（ms）。用于倒计时显示（5min 超时）。缺省取组件 mount 时间近似。 */
  startedAt?: number
}>(), {
  startedAt: () => Date.now(),
})
const emit = defineEmits<{
  submit: [answers: string]   // JSON.stringify(AskUserAnswers)
  cancel: []
}>()

// ── 倒计时（5min 超时，每秒刷新剩余）──
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const TIMEOUT_MINUTES = 5 // 对齐 runtime ExtensionTimeoutManager 5min 超时
const TIMEOUT_MS = TIMEOUT_MINUTES * SEC_PER_MIN * MS_PER_SEC
const TIME_FIELD_PAD = 2 // mm/ss 两位补零
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, MS_PER_SEC)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
/** 剩余秒数（下界 0，请求到达 + 5min 超时） */
const remainingSec = computed(() => {
  const elapsed = now.value - props.startedAt
  return Math.max(0, Math.floor((TIMEOUT_MS - elapsed) / MS_PER_SEC))
})
/** mm:ss 格式倒计时文本 */
const countdownText = computed(() => {
  const s = remainingSec.value
  const mm = String(Math.floor(s / SEC_PER_MIN)).padStart(TIME_FIELD_PAD, '0')
  const ss = String(s % SEC_PER_MIN).padStart(TIME_FIELD_PAD, '0')
  return `${mm}:${ss}`
})

// ── 问题 key（header 缺失时用 question 文本）──
function qKey(q: AskUserQuestion): string {
  return q.header ?? q.question
}

// ── tab 状态 ──
const activeIdx = ref(0)
const activeQuestion = computed(() => props.questions[activeIdx.value])

// ── 每个问题的答案状态 ──
interface QState {
  selectedValues: string[]     // 选中的 option value（单选长度 0/1，多选任意）
  otherText: string            // Other 自由文本
  comment: string              // 附加评论
}
const states = ref<Record<string, QState>>({})

// 初始化 / 重置状态（props.questions 变化时）
watch(() => props.questions, (qs) => {
  const next: Record<string, QState> = {}
  for (const q of qs) {
    const key = qKey(q)
    next[key] = states.value[key] ?? { selectedValues: [], otherText: '', comment: '' }
  }
  states.value = next
  activeIdx.value = 0
}, { immediate: true })

// ── 选项 value 解析（value 缺失时用 label）──
function optValue(o: AskUserOption): string {
  return o.value ?? o.label
}

// ── 单选 / 多选 toggle ──
function toggleOption(q: AskUserQuestion, value: string): void {
  const st = states.value[qKey(q)]
  if (!st) return
  if (q.multiSelect) {
    const idx = st.selectedValues.indexOf(value)
    if (idx >= 0) st.selectedValues.splice(idx, 1)
    else st.selectedValues.push(value)
  } else {
    st.selectedValues = st.selectedValues[0] === value ? [] : [value]
  }
}

function isSelected(q: AskUserQuestion, value: string): boolean {
  return states.value[qKey(q)]?.selectedValues.includes(value) ?? false
}

// 是否在选项末尾追加 Other 输入框（有 options 且 allowOther !== false）
function showOther(q: AskUserQuestion): boolean {
  return q.options != null && q.allowOther !== false
}

// ── Submit：构造 answers JSON ──
function onSubmit(): void {
  const answers: Record<string, string> = {}
  for (const q of props.questions) {
    const key = qKey(q)
    const st = states.value[key]
    if (!st) continue

    if (q.options?.length) {
      // 有选项的问题：选中项作为主答案
      if (st.selectedValues.length > 0) {
        answers[key] = q.multiSelect
          ? JSON.stringify(st.selectedValues)   // 多选：JSON 数组
          : st.selectedValues[0]                // 单选：单个 value string
      }
      // Other 自由文本（独立 key，仅 options 存在时追加）
      if (st.otherText && showOther(q)) {
        answers[`${key}__other`] = st.otherText
      }
    } else {
      // 无选项的纯自由文本问题：输入文本作为主答案
      if (st.otherText) {
        answers[key] = st.otherText
      }
    }
    // 评论（独立 key）
    if (st.comment) {
      answers[`${key}__comment`] = st.comment
    }
  }
  emit('submit', JSON.stringify(answers))
}
</script>

<template>
  <!-- W2 inline 卡片：由 Panel.vue 直接挂载（覆盖 composer 位置），不再包 Dialog。
       结构对齐 demo v2：ask-user-head（来源 + 倒计时）/ ask-user-body（tab + 问题 + 选项）/ actions。 -->
  <div
    data-testid="ask-user-overlay"
    class="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-2 shadow-lg"
  >
    <!-- 请求头：脉冲圆点 + 来源标识 + 右上倒计时（5min 超时，warning 色） -->
    <div
      data-testid="ask-user-head"
      class="flex items-center gap-2 border-b border-border bg-accent-soft px-3.5 py-2"
    >
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span class="text-[13px] font-medium text-accent">ask-user</span>
      <span class="text-[13px] text-text-muted">· 需要你的输入才能继续</span>
      <span class="flex-1" />
      <span
        data-testid="ask-user-countdown"
        class="flex items-center gap-0.5 font-mono text-[11px] text-warning"
      >
        <Clock class="size-3" />
        {{ countdownText }}
      </span>
    </div>

    <!-- 问题区域 -->
    <div class="flex flex-col gap-3.5 px-4 py-3.5">
      <!-- tab 导航（多问题时显示） -->
      <div v-if="questions.length > 1" class="flex gap-0.5 border-b border-border">
        <Button
          v-for="(q, i) in questions"
          :key="i"
          variant="ghost"
          :class="[
            'rounded-none -mb-px border-b-2 px-3 py-2 text-[13px] font-normal transition-colors',
            i === activeIdx
              ? 'border-accent font-medium text-foreground'
              : 'border-transparent text-text-muted hover:text-foreground',
          ]"
          :data-testid="`ask-user-tab-${i}`"
          @click="activeIdx = i"
        >
          {{ q.header ?? q.question.slice(0, 12) }}
        </Button>
      </div>

      <!-- 当前问题面板 -->
      <div v-if="activeQuestion" class="flex flex-col gap-2.5">
        <!-- 上下文摘要（弱化背景 + 左侧 reasoning 色竖条，对齐 demo v2 .q-context） -->
        <p
          v-if="activeQuestion.context"
          class="rounded-sm border-l-2 border-[var(--reasoning)] bg-input px-3 py-2 text-[13px] text-text-muted"
        >
          {{ activeQuestion.context }}
        </p>

        <!-- 问题文本（统一 13px，medium 字重做强调） -->
        <p
          class="text-[13px] font-medium text-foreground"
          data-testid="ask-user-question-text"
        >
          {{ activeQuestion.question }}
        </p>

        <!-- 选项列表（单选/多选） -->
        <div v-if="activeQuestion.options?.length" class="flex flex-col gap-1.5">
          <div
            v-for="opt in activeQuestion.options"
            :key="optValue(opt)"
            :data-testid="`ask-user-option-${optValue(opt)}`"
            :class="[
              'flex cursor-pointer items-start gap-2.5 rounded-sm border bg-input px-3 py-2 transition-colors',
              isSelected(activeQuestion, optValue(opt))
                ? 'border-accent bg-accent-soft'
                : 'border-border hover:border-border-strong hover:bg-surface-hover',
            ]"
            @click="toggleOption(activeQuestion, optValue(opt))"
          >
            <Checkbox
              v-if="activeQuestion.multiSelect"
              :model-value="isSelected(activeQuestion, optValue(opt))"
              class="mt-0.5"
              @update:model-value="toggleOption(activeQuestion, optValue(opt))"
            />
            <div
              v-else
              :class="[
                'mt-0.5 size-4 shrink-0 rounded-full border-2',
                isSelected(activeQuestion, optValue(opt))
                  ? 'border-accent bg-accent'
                  : 'border-border-strong',
              ]"
            />
            <div class="flex flex-col gap-0.5">
              <span
                data-testid="ask-user-option-label"
                class="text-[13px] font-normal text-foreground"
              >{{ opt.label }}</span>
              <span
                v-if="opt.description"
                data-testid="ask-user-option-desc"
                class="text-[13px] text-text-muted"
              >{{ opt.description }}</span>
            </div>
          </div>
        </div>

        <!-- Other 自由文本（有 options 时追加） -->
        <div v-if="showOther(activeQuestion)" class="flex flex-col gap-1">
          <Input
            v-model="states[qKey(activeQuestion)].otherText"
            placeholder="Other（自由输入）"
            :data-testid="`ask-user-other-${qKey(activeQuestion)}`"
          />
        </div>

        <!-- 无 options 的纯自由文本输入 -->
        <Textarea
          v-if="!activeQuestion.options?.length"
          v-model="states[qKey(activeQuestion)].otherText"
          rows="3"
          placeholder="请输入..."
          data-testid="ask-user-free-text"
        />

        <!-- 附加评论 -->
        <div v-if="activeQuestion.allowComment" class="flex flex-col gap-1">
          <Input
            v-model="states[qKey(activeQuestion)].comment"
            placeholder="附加评论（可选）"
            :data-testid="`ask-user-comment-${qKey(activeQuestion)}`"
          />
        </div>
      </div>
    </div>

    <!-- 操作区 -->
    <div class="flex items-center justify-end gap-2 border-t border-border bg-surface px-4 py-2.5">
      <Button
        v-if="allowCancel !== false"
        variant="ghost"
        data-testid="ask-user-cancel"
        @click="emit('cancel')"
      >
        取消
      </Button>
      <Button variant="default" data-testid="ask-user-submit" @click="onSubmit">
        提交
      </Button>
    </div>
  </div>
</template>
