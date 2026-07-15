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
 * 样式对齐 demo v3（docs/page-design/v3/ask-user/inline-ask-user-demo-v3.html）：
 * - 无边框一体化：去掉 border-b/border-t 分层，单容器 bg-input 靠间距分区
 * - head 行：脉冲点 + 单问题标题(或 tab) + 倒计时(absolute 右上角不受换行影响)
 * - 选项 inline：indicator + label + description 同行流式，无边框 hover/selected 用 bg
 * - Other 卡片化：最后一个选项(label="其他")，选中后 label 下方展开输入框
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Clock } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
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

const { t } = useI18n()

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
/** 紧迫态：剩余 < 1min 才转 warning 色（对齐 pi TUI 仅尾部高亮，避免全程橙黄制造焦虑） */
const isUrgent = computed(() => remainingSec.value < SEC_PER_MIN)

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

/** Other 特殊选项的 value（卡片化，选中后展开输入框）*/
const OTHER_VALUE = '__other__'

/** Other 选项是否选中（控制输入框展开）*/
function isOtherSelected(q: AskUserQuestion): boolean {
  return isSelected(q, OTHER_VALUE)
}

// ── 单选 / 多选 toggle ──
// 单选选中后自动前进到下一题（对齐 pi TUI advanceAfterAnswer），多选不前进。
// Other 是特殊选项（OTHER_VALUE）：选中不 auto-advance，展开 input 并自动聚焦。
function toggleOption(q: AskUserQuestion, value: string): void {
  const st = states.value[qKey(q)]
  if (!st) return
  if (q.multiSelect) {
    const idx = st.selectedValues.indexOf(value)
    if (idx >= 0) {
      st.selectedValues.splice(idx, 1)
      if (value === OTHER_VALUE) st.otherText = '' // 取消 Other 清文本
    } else {
      st.selectedValues.push(value)
      if (value === OTHER_VALUE) focusOtherInput() // 选中 Other 聚焦 input
    }
  } else {
    st.selectedValues = st.selectedValues[0] === value ? [] : [value]
    if (st.selectedValues.length > 0 && value !== OTHER_VALUE) {
      st.otherText = '' // 选普通选项清 Other（互斥）
      advanceToNext()
    } else if (value === OTHER_VALUE && st.selectedValues.length > 0) {
      focusOtherInput() // 选中 Other 聚焦 input
    }
    // 选 Other 时不 auto-advance（用户要输入文本），不前进
  }
}

/** Other input 组件实例引用（选中展开后自动聚焦）*/
const otherInputComp = ref<{ $el: HTMLInputElement } | null>(null)

/** Other 选中后聚焦 input（等 v-if 渲染完成）*/
function focusOtherInput(): void {
  nextTick(() => {
    // shadcn Input 根元素就是 <input>，$el 直接是原生 input
    otherInputComp.value?.$el?.focus()
  })
}

function isSelected(q: AskUserQuestion, value: string): boolean {
  return states.value[qKey(q)]?.selectedValues.includes(value) ?? false
}

/** 单选选中后自动前进到下一题；已是最后一题则停（Submit 常驻底部 action bar） */
function advanceToNext(): void {
  if (activeIdx.value < props.questions.length - 1) {
    activeIdx.value++
  }
}

/** 当前问题是否为最后一题（决定按钮显示"下一题"还是"提交"）*/
const isLastQuestion = computed(() => activeIdx.value >= props.questions.length - 1)

/** Other input 的 Enter 处理：非最后一题前进到下一题，最后一题不拦截（让按钮提交）*/
function onOtherEnter(): void {
  if (!isLastQuestion.value) {
    advanceToNext()
  } else if (allAnswered.value) {
    onSubmit()
  }
}

/** 点击"下一题"按钮：前进到下一题 */
function onNextQuestion(): void {
  advanceToNext()
}

/** 问题是否已作答（普通选项选中 ≥1，或 Other 选中且有文本，或无选项问题 otherText 有值）
 *  —— tab 绿点 + allAnswered 共用 */
function isQuestionAnswered(q: AskUserQuestion): boolean {
  const st = states.value[qKey(q)]
  if (!st) return false
  // 无选项的纯自由文本问题：otherText 有值即答完
  if (!q.options?.length) return st.otherText.trim().length > 0
  // 有选项：Other 选中必须有文本才算答完
  const otherSelected = st.selectedValues.includes(OTHER_VALUE)
  if (otherSelected && !st.otherText.trim()) {
    // Other 选中但没文本：检查是否还选了其他选项（多选场景）
    return st.selectedValues.some((v) => v !== OTHER_VALUE)
  }
  return st.selectedValues.length > 0
}

/** 全部问题已作答（Submit 启用守卫，对齐 pi TUI allAnswered） */
const allAnswered = computed(() => props.questions.every(isQuestionAnswered))
/** 未答题数（disabled tooltip 文案） */
const unansweredCount = computed(() => props.questions.filter((q) => !isQuestionAnswered(q)).length)

/** Tab / Shift+Tab 在问题间循环导航（多问题时生效） */
function onTabKey(e: KeyboardEvent): void {
  if (props.questions.length <= 1) return
  e.preventDefault()
  const total = props.questions.length
  if (e.shiftKey) {
    activeIdx.value = (activeIdx.value - 1 + total) % total
  } else {
    activeIdx.value = (activeIdx.value + 1) % total
  }
}

// 是否在选项末尾追加 Other 输入框（有 options 且 allowOther !== false）
function showOther(q: AskUserQuestion): boolean {
  return q.options != null && q.allowOther !== false
}

// ── Submit：构造 answers JSON ──
// Other 选中时，otherText 文本替代 OTHER_VALUE 占位符作为实际答案值。
function onSubmit(): void {
  const answers: Record<string, string> = {}
  for (const q of props.questions) {
    const key = qKey(q)
    const st = states.value[key]
    if (!st) continue

    if (q.options?.length) {
      // 有选项的问题：选中项作为主答案（Other 选中时用 otherText 文本替代占位符）
      const vals = st.selectedValues.map((v) => v === OTHER_VALUE ? (st.otherText || '') : v).filter(Boolean)
      if (vals.length > 0) {
        answers[key] = q.multiSelect ? JSON.stringify(vals) : vals[0]
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
  <!-- v3 无边框一体化：单容器靠间距分区，head 行含脉冲点+标题/tab+倒计时(absolute)。
       选项 inline（indicator + label + desc 同行流式），无边框 hover/selected 用 bg。
       Other 卡片化：最后一个选项，选中后 label 下方展开输入框。 -->
  <div
    data-testid="ask-user-overlay"
    class="relative flex flex-col animate-ask-user-slide-up overflow-hidden rounded-lg bg-bg-input motion-reduce:animate-none"
    @keydown.tab="onTabKey"
  >
    <!-- head 行：脉冲点 + (单问题标题 | 多问题 tab) + 倒计时(absolute 右上) -->
    <div
      data-testid="ask-user-head"
      class="relative flex items-center gap-[7px] pt-2.5"
      :class="questions.length > 1 ? 'px-3.5' : 'px-3.5'"
    >
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <!-- 单问题：标题提到 head 行，单行 truncate，pr 给 timer 留空间 -->
      <span
        v-if="questions.length <= 1"
        class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap pr-[52px] text-[13px] font-medium text-fg"
        data-testid="ask-user-question-text"
      >
        {{ activeQuestion?.question }}
      </span>
      <!-- 多问题：tab 整合到 head 行 -->
      <div v-else class="flex items-center gap-0.5">
        <Button
          v-for="(q, i) in questions"
          :key="qKey(q)"
          variant="ghost"
          :class="[
            'rounded-sm px-2.5 py-1 text-[12px] font-normal transition-colors',
            i === activeIdx
              ? 'bg-accent-soft font-medium text-fg'
              : 'text-subtle hover:text-muted',
          ]"
          :data-testid="`ask-user-tab-${i}`"
          @click="activeIdx = i"
        >
          {{ q.header ?? q.question.slice(0, 12) }}
          <span
            v-if="isQuestionAnswered(q)"
            data-testid="ask-user-tab-answered"
            class="size-[5px] rounded-full bg-success"
          />
        </Button>
      </div>
      <span class="flex-1" />
      <!-- 倒计时：absolute 固定右上角，不受 head 内容换行影响 -->
      <span
        data-testid="ask-user-countdown"
        class="absolute right-3.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 bg-bg-input pl-1.5 font-mono text-[11px]"
        :class="isUrgent ? 'text-warning' : 'text-subtle'"
        style="margin-top: 5px"
      >
        <Clock class="size-3" />
        {{ countdownText }}
      </span>
    </div>

    <!-- body：问题内容 + 选项，紧凑间距 -->
    <div class="flex flex-col gap-2 px-3.5 pb-1 pt-2.5">
      <!-- 多问题时：当前问题文本 + context -->
      <template v-if="activeQuestion">
        <!-- context（reasoning-soft 软底，无边框） -->
        <p
          v-if="activeQuestion.context"
          data-testid="ask-user-context"
          class="rounded bg-[var(--reasoning-soft)] px-2.5 py-1.5 text-[12px] leading-1.5 text-text-muted"
        >
          {{ activeQuestion.context }}
        </p>

        <!-- 多问题时的问题文本（单问题已在 head 行） -->
        <p
          v-if="questions.length > 1"
          class="py-0.5 text-[13px] font-medium text-fg"
          data-testid="ask-user-question-text-multi"
        >
          {{ activeQuestion.question }}
        </p>

        <!-- 选项列表（单选/多选）：inline 布局，无边框，hover/selected 用 bg -->
        <div v-if="activeQuestion.options?.length" class="flex flex-col gap-[3px]">
          <div
            v-for="opt in activeQuestion.options"
            :key="optValue(opt)"
            :data-testid="`ask-user-option-${optValue(opt)}`"
            :role="activeQuestion.multiSelect ? 'checkbox' : 'radio'"
            :tabindex="0"
            :aria-checked="isSelected(activeQuestion, optValue(opt))"
            :class="[
              'flex cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
              isSelected(activeQuestion, optValue(opt))
                ? 'bg-accent-soft'
                : 'hover:bg-white/[0.04]',
            ]"
            @click="toggleOption(activeQuestion, optValue(opt))"
            @keydown.enter="toggleOption(activeQuestion, optValue(opt))"
            @keydown.space.prevent="toggleOption(activeQuestion, optValue(opt))"
          >
            <!-- indicator：钉首行文字中线 -->
            <Checkbox
              v-if="activeQuestion.multiSelect"
              :model-value="isSelected(activeQuestion, optValue(opt))"
              class="mt-[2.25px]"
              @update:model-value="toggleOption(activeQuestion, optValue(opt))"
            />
            <div
              v-else
              :class="[
                'mt-[2.25px] size-[15px] shrink-0 rounded-full border-[1.5px] transition-colors',
                isSelected(activeQuestion, optValue(opt))
                  ? 'border-accent bg-accent'
                  : 'border-border-strong',
              ]"
            />
            <!-- 内容：label + desc inline 同行 -->
            <div class="flex min-w-0 flex-1 flex-col">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span
                  data-testid="ask-user-option-label"
                  class="text-[13px] font-normal leading-1.5 text-fg"
                >{{ opt.label }}</span>
                <span
                  v-if="opt.description"
                  data-testid="ask-user-option-desc"
                  class="text-[12px] leading-1.5 text-subtle"
                >{{ opt.description }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Other 卡片化选项（有 options 且 allowOther !== false）。
             作为最后一个选项卡片，选中后 label 下方展开输入框 -->
        <div
          v-if="showOther(activeQuestion)"
          :data-testid="`ask-user-option-${OTHER_VALUE}`"
          :role="activeQuestion.multiSelect ? 'checkbox' : 'radio'"
          :tabindex="0"
          :aria-checked="isOtherSelected(activeQuestion)"
          :class="[
            'flex cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
            isOtherSelected(activeQuestion) ? 'bg-accent-soft' : 'hover:bg-white/[0.04]',
          ]"
          @click="toggleOption(activeQuestion, OTHER_VALUE)"
          @keydown.enter="toggleOption(activeQuestion, OTHER_VALUE)"
          @keydown.space.prevent="toggleOption(activeQuestion, OTHER_VALUE)"
        >
          <Checkbox
            v-if="activeQuestion.multiSelect"
            :model-value="isOtherSelected(activeQuestion)"
            class="mt-[2.25px]"
            @update:model-value="toggleOption(activeQuestion, OTHER_VALUE)"
          />
          <div
            v-else
            :class="[
              'mt-[2.25px] size-[15px] shrink-0 rounded-full border-[1.5px] transition-colors',
              isOtherSelected(activeQuestion) ? 'border-accent bg-accent' : 'border-border-strong',
            ]"
          />
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="text-[13px] font-normal leading-1.5 text-fg">{{ t('extensionUI.other') }}</span>
            <!-- 选中时展开输入框（独立成行，自动聚焦）。
                 @keydown.stop 阻止冒泡到卡片容器；Enter 单独处理前进到下一题 -->
            <Input
              v-if="isOtherSelected(activeQuestion)"
              ref="otherInputComp"
              v-model="states[qKey(activeQuestion)].otherText"
              :placeholder="t('extensionUI.customAnswerPlaceholder')"
              :data-testid="`ask-user-other-${qKey(activeQuestion)}`"
              class="mt-1.5"
              @click.stop
              @keydown.enter.stop="onOtherEnter"
              @keydown.space.stop
            />
          </div>
        </div>

        <!-- 无 options 的纯自由文本输入 -->
        <Textarea
          v-if="!activeQuestion.options?.length"
          v-model="states[qKey(activeQuestion)].otherText"
          rows="3"
          :placeholder="t('extensionUI.inputPlaceholder')"
          data-testid="ask-user-free-text"
        />

        <!-- 附加评论 -->
        <div v-if="activeQuestion.allowComment" class="flex flex-col gap-0.5">
          <span class="pl-0.5 text-[11px] text-subtle">{{ t('extensionUI.additionalComment') }}</span>
          <Input
            v-model="states[qKey(activeQuestion)].comment"
            :placeholder="t('extensionUI.commentPlaceholder')"
            :data-testid="`ask-user-comment-${qKey(activeQuestion)}`"
          />
        </div>
      </template>
    </div>

    <!-- actions：无边框，透明继承根。非最后一题显示"下一题"，最后一题显示"提交"(守卫 allAnswered) -->
    <div class="flex items-center justify-end gap-2 px-3.5 pb-2.5 pt-1">
      <Button
        v-if="allowCancel !== false"
        variant="ghost"
        data-testid="ask-user-cancel"
        @click="emit('cancel')"
      >
        {{ t('common.cancel') }}
      </Button>
      <Button
        v-if="!isLastQuestion"
        variant="default"
        data-testid="ask-user-next"
        :disabled="!isQuestionAnswered(activeQuestion!)"
        @click="onNextQuestion"
      >
        {{ t('common.next') }}
      </Button>
      <Button
        v-else
        variant="default"
        data-testid="ask-user-submit"
        :disabled="!allAnswered"
        :title="allAnswered ? t('common.submit') : t('extensionUI.unansweredHint', { count: unansweredCount })"
        @click="onSubmit"
      >
        {{ t('common.submit') }}
      </Button>
    </div>
  </div>
</template>
