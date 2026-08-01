<script setup lang="ts">
import { ref, computed, reactive, nextTick } from 'vue'

/**
 * §4.6 AskUserOverlay · 内联 companion 覆盖层（非 modal，无遮罩）。
 * 落 companion-band（composer 上方），z-overlay(20)。
 * 根 au-overlay：bg-input + radius-lg + shadow-2。
 * v6 降噪：context 用中性 bg-surface-hover（去 reasoning 软底彩色）；选项 hover/selected 走 §3.2 列表项型。
 * 多问题（questions 传入）：head 行渲染 .au-tab 切换栏（无 border、tab 全圆角 6px、active=bg-elevated+500、
 *   已答问题 tab 显 7px success 绿点）；单选选中后 auto-advance，最后问题选完自动提交（Other 输入态手动提交）。
 * 多选（opt.multiple）：checkbox（accent 实心圆角方块 + 白勾 10px），selected 为数组，点击 toggle，不自动推进。
 */

interface OptItem {
  value: string
  label: string
  desc?: string
  disabled?: boolean
  /** 多选问题标记（任一选项带 multiple 即整题 checkbox）*/
  multiple?: boolean
  /** Other 选项：列表末尾追加，选中后 label 下方展开 Input（自动聚焦）*/
  isOther?: boolean
}

interface AskQuestion {
  id?: string
  title: string
  options: OptItem[]
}

const props = withDefaults(defineProps<{
  question?: string
  context?: string
  ctxTag?: string
  options?: OptItem[]
  defaultSelected?: string
  cancelText?: string
  confirmText?: string
  /** 多问题列表：传入后切换为 tab 形态（au-tab + 7px success dot）*/
  questions?: AskQuestion[]
}>(), {
  question: '选择目标环境？',
  context: '当前分支：feat-optimize-ui',
  ctxTag: 'context',
  options: () => [
    { value: 'production', label: 'production', desc: '生产环境，正式部署' },
    { value: 'staging', label: 'staging', desc: '预发布，验证用' },
    { value: 'development', label: 'development', desc: '本地开发，调试用' },
  ],
  defaultSelected: 'production',
  cancelText: '取消',
  confirmText: '提交',
  questions: () => [],
})

/** 提交载荷：单问题 = { values, otherText }；多问题 = 每问数组 */
export type AskUserAnswer = { id: string; title: string; values: string[]; otherText: string }
const emit = defineEmits<{
  confirm: [payload: { values: string[]; otherText: string } | AskUserAnswer[]]
  cancel: []
}>()

/** 是否 tab 形态（questions 传入即多问题，spec §3） */
const isMulti = computed(() => (props.questions?.length ?? 0) >= 1)

/** 多问题当前激活 tab idx */
const activeQ = ref(0)

/** 每问答案分区：key = q.id ?? index（单问题 = 'single'）→ 选中 values（单选 ≤1 项）*/
const answers = reactive<Record<string, string[]>>({})
/** Other 输入文本分区（按同 key）*/
const otherTexts = reactive<Record<string, string>>({})

/** 单问题形态初始选中 */
if (!isMulti.value) {
  answers['single'] = [props.defaultSelected]
}

function keyFor(i: number): string {
  if (i < 0) return 'single'
  return props.questions[i].id ?? String(i)
}
const currentKey = computed(() => keyFor(isMulti.value ? activeQ.value : -1))

/** 当前问题（多问题取 tab 项；否则构造单个） */
const currentQuestion = computed<AskQuestion>(() => {
  if (isMulti.value) return props.questions[activeQ.value] ?? props.questions[0]
  return { id: 'single', title: props.question, options: props.options }
})

/** 当前问题是否多选（任一选项 multiple → 整题 checkbox） */
const isQuestionMultiple = computed(() => currentQuestion.value.options.some((o) => o.multiple))

/** 是否最后一题（单问题恒 true） */
const isLast = computed(() => !isMulti.value || activeQ.value >= props.questions.length - 1)

/** 选项渲染顺序：Other 追加到列表末尾（spec §3 anno） */
const orderedOptions = computed<OptItem[]>(() => {
  const q = currentQuestion.value
  return [...q.options.filter((o) => !o.isOther), ...q.options.filter((o) => o.isOther)]
})

/** 某题是否已回答（tab 绿点 / next 守卫共用） */
function answeredAt(i: number): boolean {
  return (answers[keyFor(i)] ?? []).length > 0
}

function isSel(opt: OptItem): boolean {
  return (answers[currentKey.value] ?? []).includes(opt.value)
}

/** 当前题是否满足推进条件：Other 选中须已输入文本；其余须 ≥1 选中 */
const canNext = computed(() => {
  const vals = answers[currentKey.value] ?? []
  const hasOther = currentQuestion.value.options.some((o) => o.isOther && vals.includes(o.value))
  if (hasOther) return (otherTexts[currentKey.value] ?? '').trim().length > 0
  return vals.length > 0
})

const otherInputRef = ref<HTMLInputElement | null>(null)
function focusOther() {
  nextTick(() => otherInputRef.value?.focus())
}

function select(opt: OptItem) {
  if (opt.disabled) return
  const key = currentKey.value
  const vals = answers[key] ?? []
  if (isQuestionMultiple.value) {
    // 多选：toggle，不自动推进（需手动 next/submit，避免选一项就跳走）
    answers[key] = vals.includes(opt.value)
      ? vals.filter((v) => v !== opt.value)
      : [...vals, opt.value]
    if (opt.isOther && answers[key].includes(opt.value)) focusOther()
    return
  }
  // 单选
  answers[key] = [opt.value]
  if (opt.isOther) {
    // Other 输入态：需显式确认输入内容（spec §3 手动提交）
    focusOther()
    return
  }
  // v6 交互优化：最后问题选完自动提交；非最后问题自动下一题
  if (isLast.value) {
    emit('confirm', buildPayload())
  } else {
    activeQ.value++
  }
}

function onNextOrSubmit() {
  if (!canNext.value) return
  if (isLast.value) {
    emit('confirm', buildPayload())
  } else {
    activeQ.value++
  }
}

function onCancel() {
  emit('cancel')
}

function buildPayload(): { values: string[]; otherText: string } | AskUserAnswer[] {
  if (!isMulti.value) {
    return { values: answers['single'] ?? [], otherText: otherTexts['single'] ?? '' }
  }
  return props.questions.map((q, i) => ({
    id: keyFor(i),
    title: q.title,
    values: answers[keyFor(i)] ?? [],
    otherText: otherTexts[keyFor(i)] ?? '',
  }))
}
</script>

<template>
  <div class="au-companion">
    <div class="au-overlay">
      <!-- head：脉冲点 +（多问题 → tab 行 / 单问题 → 标题） -->
      <div class="au-head">
        <span class="au-dot"></span>
        <!-- 多问题 tab 行：无 border · tab 全圆角 6px · active=bg-elevated+500 · 已答 tab 显绿点 -->
        <div v-if="isMulti" class="au-tabs">
          <button
            v-for="(q, i) in questions"
            :key="q.id ?? i"
            class="au-tab"
            :class="{ on: i === activeQ }"
            @click="activeQ = i"
          >
            <span>{{ q.title }}</span>
            <span v-if="answeredAt(i)" class="au-tab-dot"></span>
          </button>
        </div>
        <!-- 单问题标题 -->
        <span v-else class="au-q">{{ currentQuestion.title }}</span>
      </div>

      <!-- body -->
      <div class="au-body">
        <!-- context：中性 bg-surface-hover（去 reasoning 软底彩色），多问题 demo 可不传 -->
        <div v-if="context" class="au-ctx">
          <span class="au-ctx-tag">{{ ctxTag }}</span>{{ context }}
        </div>

        <!-- 多问题：当前题标题（au-q-multi） -->
        <p v-if="isMulti" class="au-q-multi">{{ currentQuestion.title }}</p>

        <!-- 选项列表：多选=checkbox / 单选=radio；Other 末尾 + 选中后展开 Input -->
        <div class="au-opts">
          <div
            v-for="opt in orderedOptions"
            :key="opt.value"
            class="au-opt"
            :class="{ sel: isSel(opt), disabled: opt.disabled }"
            @click="select(opt)"
          >
            <!-- 多选 checkbox：accent 实心圆角方块 + 白勾 10px -->
            <span v-if="isQuestionMultiple" class="au-check">
              <svg v-if="isSel(opt)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
            <!-- 单选 radio -->
            <span v-else class="au-radio"></span>
            <div class="au-opt-body">
              <span class="au-opt-label">{{ opt.label }}</span>
              <span v-if="opt.desc" class="au-opt-desc">{{ opt.desc }}</span>
              <!-- Other：选中后 label 下方展开 Input（自动聚焦）-->
              <input
                v-if="opt.isOther && isSel(opt)"
                ref="otherInputRef"
                v-model="otherTexts[currentKey]"
                class="au-other-input"
                type="text"
                :placeholder="opt.label"
                @click.stop
                @keydown.enter.prevent="onNextOrSubmit"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- actions：cancel ghost / next·submit primary（canNext 守卫） -->
      <div class="au-actions">
        <button class="btn btn-ghost btn-dense" @click="onCancel">{{ cancelText }}</button>
        <button class="btn btn-default btn-dense" :disabled="!canNext" @click="onNextOrSubmit">
          {{ isLast ? confirmText : '下一题' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* companion 外壳（spec 渲染时 padding:14px，组件内不写死，由父 companion-band 控间距；这里给默认留白）*/
.au-companion {
  position: relative;
  z-index: var(--z-overlay);
  padding: 14px;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
}
/* 内联覆盖层根：bg-input + radius-lg(12px) */
.au-overlay {
  background: var(--bg-input);
  border-radius: var(--radius-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* head */
.au-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 0;
}
.au-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: au-pulse 1.8s ease-in-out infinite;
}
@keyframes au-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.au-q {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 多问题 tab 行（spec §3.1 tab 型）：无 border · tab 全圆角 6px · active=bg-elevated+500（去 accent-soft 蓝染） */
.au-tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
}
.au-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--neutral-dim);
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.au-tab:hover {
  background: var(--surface-hover);
  color: var(--neutral-mid);
}
.au-tab.on {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
  font-weight: 500;
}
/* 已答问题 tab 绿点（7px --success）*/
.au-tab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}

/* body */
.au-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 4px;
}
/* 多问题当前题标题 */
.au-q-multi {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--neutral-fg);
}
/* v6 context：中性 bg-surface-hover（去 reasoning 软底彩色）*/
.au-ctx {
  background: var(--surface-hover);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--neutral-mid);
}
.au-ctx-tag {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 999px;
  margin-right: 6px;
  background: var(--surface-2);
  color: var(--neutral-dim);
}

/* 选项列表 */
.au-opts {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.au-opt {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
  text-align: left;
}
.au-opt:hover {
  background: var(--surface-hover);
}
/* §3.2 列表项型选中：bg-surface + accent 文字（与 hover 实色块区分）*/
.au-opt.sel {
  background: var(--surface);
}
.au-opt.sel .au-opt-label {
  color: var(--accent);
}
.au-opt.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.au-opt.disabled:hover {
  background: transparent;
}

/* radio：unchecked = border-strong 空心；checked = accent 实心（inset 留 bg-input 形成环）*/
.au-radio {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
  margin-top: 2px;
  box-sizing: border-box;
  transition: border-color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
}
.au-opt.sel .au-radio {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 2px var(--bg-input);
}

/* 多选 checkbox：accent 实心圆角方块 + 白勾 10px */
.au-check {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 2px solid var(--border-strong);
  border-radius: var(--radius-sm);
  margin-top: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  transition: border-color var(--duration-fast) var(--ease), background var(--duration-fast) var(--ease);
}
.au-opt.sel .au-check {
  border-color: var(--accent);
  background: var(--accent);
}
.au-check svg {
  width: 10px;
  height: 10px;
  color: #fff;
}

/* Other 输入：选中后 label 下方展开，bg-surface-2 内嵌 */
.au-other-input {
  flex-basis: 100%;
  margin-top: 2px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-size: var(--text-sm);
  color: var(--neutral-fg);
}
.au-other-input::placeholder {
  color: var(--neutral-dim);
}
.au-other-input:focus {
  box-shadow: 0 0 0 2px var(--accent-ring);
}

.au-opt-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 1px 8px;
}
.au-opt-label {
  font-size: var(--text-base);
  line-height: 1.5;
  color: var(--neutral-fg);
}
.au-opt-desc {
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--neutral-dim);
}

/* actions */
.au-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 14px 10px;
}
.au-actions .btn:disabled {
  pointer-events: none;
  opacity: 0.5;
}
</style>
