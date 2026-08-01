<script setup lang="ts">
import { ref, computed } from 'vue'

/**
 * §4.6 AskUserOverlay · 内联 companion 覆盖层（非 modal，无遮罩）。
 * 落 companion-band（composer 上方），z-overlay(20)。
 * 根 au-overlay：bg-input + radius-lg + shadow-2。
 * v6 降噪：context 用中性 bg-surface-hover（去 reasoning 软底彩色）；选项 hover/selected 走 §3.2 列表项型。
 * 单问题：选中即提交（select 时若单问题，立即 emit confirm）。
 * 多问题（questions 传入多个）：渲染 .au-tab 切换栏（带 7px au-tab-dot），骨架仅做切换。
 * 本组件作为独立可展示组件存在（不在 App.vue 渲染），demo 单选目标环境。
 */

interface OptItem {
  value: string
  label: string
  desc?: string
  disabled?: boolean
}

interface AskQuestion {
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
  /** 多问题列表：传入多个时切换为 tab 形态（au-tab + 7px au-tab-dot）*/
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
  confirmText: '确认',
  questions: () => [],
})

const emit = defineEmits<{
  confirm: [value: string]
  cancel: []
}>()

/** 是否多问题形态（questions 传入 ≥2 个） */
const isMulti = computed(() => (props.questions?.length ?? 0) >= 2)

/** 多问题当前激活 tab idx */
const activeQ = ref(0)

/** 当前问题（多问题取 tab 项；否则构造单个） */
const currentQuestion = computed<AskQuestion>(() => {
  if (isMulti.value) return props.questions[activeQ.value] ?? props.questions[0]
  return { title: props.question, options: props.options }
})

const selected = ref<string>(props.defaultSelected)

function select(opt: OptItem) {
  if (opt.disabled) return
  selected.value = opt.value
  // 单问题：选完即提交（demo 行为）
  if (!isMulti.value) {
    emit('confirm', opt.value)
  }
}

function onConfirm() {
  emit('confirm', selected.value)
}
function onCancel() {
  emit('cancel')
}
</script>

<template>
  <div class="au-companion">
    <div class="au-overlay">
      <!-- 多问题 tab 切换栏（仅 questions ≥2 时渲染，带 7px au-tab-dot） -->
      <div v-if="isMulti" class="au-tabs">
        <button
          v-for="(q, i) in questions"
          :key="i"
          class="au-tab"
          :class="{ on: i === activeQ }"
          @click="activeQ = i"
        >
          <span class="au-tab-dot"></span>
          <span class="au-tab-label">{{ q.title }}</span>
        </button>
      </div>

      <!-- head：脉冲点 + 问题标题 -->
      <div class="au-head">
        <span class="au-dot"></span>
        <span class="au-q">{{ currentQuestion.title }}</span>
      </div>

      <!-- body -->
      <div class="au-body">
        <!-- context：中性 bg-surface-hover -->
        <div class="au-ctx">
          <span class="au-ctx-tag">{{ ctxTag }}</span>{{ context }}
        </div>

        <!-- 单选选项列表 -->
        <div class="au-opts">
          <button
            v-for="opt in currentQuestion.options"
            :key="opt.value"
            class="au-opt"
            :class="{ sel: opt.value === selected, disabled: opt.disabled }"
            :disabled="opt.disabled"
            @click="select(opt)"
          >
            <span class="au-radio"></span>
            <div class="au-opt-body">
              <span class="au-opt-label">{{ opt.label }}</span>
              <span v-if="opt.desc" class="au-opt-desc">{{ opt.desc }}</span>
            </div>
          </button>
        </div>
      </div>

      <!-- actions -->
      <div class="au-actions">
        <button class="btn btn-ghost btn-dense" @click="onCancel">{{ cancelText }}</button>
        <button class="btn btn-default btn-dense" @click="onConfirm">{{ confirmText }}</button>
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

/* 多问题 tab 切换栏（questions ≥2 时渲染） */
.au-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 14px 0;
  border-bottom: 1px solid var(--border);
}
.au-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 6px;
  border: 0;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  transition: all var(--duration-fast) var(--ease);
}
.au-tab:hover {
  color: var(--neutral-fg);
}
.au-tab.on {
  color: var(--neutral-fg);
}
/* au-tab-dot：7px 状态点（spec 要求） */
.au-tab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--neutral-dim);
  flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease);
}
.au-tab.on .au-tab-dot {
  background: var(--accent);
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

/* body */
.au-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 4px;
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

.au-opt-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
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
</style>
