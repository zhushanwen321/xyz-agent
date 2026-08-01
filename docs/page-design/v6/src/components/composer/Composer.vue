<script setup lang="ts">
/** Composer · 输入区（v6 spec-input §9）
 *  - .comp-box（bg-input radius-lg）内含 QueueBubble + contenteditable + composer-bar
 *  - composer-bar：+ 按钮(Plus) / 上下文容量(hover bar) / 模型(glm-5.2) / 思考等级(medium) / send-slot(ArrowUp accent)
 *  - focus 态：3px 外环 box-shadow accent-ring */
import { computed, ref } from 'vue'
import QueueBubble from './QueueBubble.vue'

const focused = ref(false)
const draft = ref('')
const showQueue = ref(true)

/** thinking level 枚举映射（数字/档位名 → 标准档位名）
 *  0=off / 1=minimal / 2=low / 3=medium / 4=high / 5=xhigh / 6=max / 'all'=all */
const THINKING_LEVEL_MAP: Record<string, string> = {
  '0': 'off',
  '1': 'minimal',
  '2': 'low',
  '3': 'medium',
  '4': 'high',
  '5': 'xhigh',
  '6': 'max',
  all: 'all',
}
function thinkingLabel(raw: string): string {
  return THINKING_LEVEL_MAP[raw] ?? raw
}

/** 当前思考等级（mock 值 '3' → 显示 'medium'） */
const thinkingRaw = ref('3')
const thinkingDisplay = computed(() => thinkingLabel(thinkingRaw.value))

/** contenteditable DOM 引用（onSend 时清空 DOM） */
const inputRef = ref<HTMLDivElement | null>(null)

function onInput(e: Event) {
  draft.value = (e.target as HTMLElement).innerText
}
function onSend(e: Event) {
  // demo：无实际发送
  draft.value = ''
  // contenteditable 不受 v-model 控制，需手动清 DOM
  const el = (e.target as HTMLElement).closest('.comp-input') as HTMLElement | null
    ?? inputRef.value
  if (el) el.textContent = ''
}
</script>

<template>
  <div class="comp-wrap">
    <div class="comp-box" :class="{ focused, 'has-input': draft.length > 0 }">
      <!-- ① QueueBubble 内嵌顶部 -->
      <QueueBubble v-if="showQueue" />

      <!-- ⑤ Input：contenteditable，min-h-60 max-h-120 -->
      <div
        ref="inputRef"
        class="comp-input"
        contenteditable="true"
        data-placeholder="描述任务…（⏎ 发送 / ⇧⏎ 换行）"
        @input="onInput"
        @focus="focused = true"
        @blur="focused = false"
      ></div>

      <!-- ⑥ composer-bar：+ / 上下文 / 模型 / 思考 / 发送位 -->
      <div class="composer-bar">
        <!-- + 添加（图标型触发器） -->
        <button class="bar-btn icon-only" title="添加附件 / 命令">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>

        <span class="bar-spacer"></span>

        <!-- 上下文容量（hover 触发，tabular-nums） -->
        <button class="bar-btn text" title="上下文容量">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="mono tabular">12K · 24%</span>
        </button>

        <!-- 模型选择（click 触发，truncate label） -->
        <button class="bar-btn text" title="模型选择">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          <span class="mono">glm-5.2</span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>

        <!-- 思考等级（click 触发，Brain + label） -->
        <button class="bar-btn text think" title="思考强度">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/></svg>
          <span>{{ thinkingDisplay }}</span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>

        <!-- 发送位（30×30 accent 圆 · 倾斜 send 箭头） -->
        <button class="send-slot" :class="{ disabled: !draft.length }" :title="draft.length ? '发送 · ⏎' : '输入内容后发送'" @click="onSend">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comp-wrap {
  flex-shrink: 0;
  padding: 8px 20px 14px;
  max-width: var(--content-max-w);
  width: 100%;
  margin: 0 auto;
}
.comp-box {
  background: var(--bg-input);
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  transition: border-color var(--duration) var(--ease), box-shadow var(--duration) var(--ease);
}
.comp-box.has-input { box-shadow: 0 0 0 2px color-mix(in oklch, var(--surface-hover) 40%, transparent); }
.comp-box.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

/* contenteditable input */
.comp-input {
  min-height: 60px;
  max-height: 120px;
  overflow-y: auto;
  padding: 11px 14px 4px;
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--neutral-fg);
  outline: none;
  white-space: pre-wrap;
  word-break: break-word;
}
.comp-input:empty::before {
  content: attr(data-placeholder);
  color: var(--neutral-dim);
  pointer-events: none;
}

/* composer-bar */
.composer-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 10px 8px;
  margin-top: 4px;
}
.bar-spacer { flex: 1; }

.bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  font-size: var(--text-xs);
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.bar-btn:hover { background: var(--surface-hover); color: var(--neutral-fg); }
.bar-btn.icon-only { width: 28px; padding: 0; justify-content: center; }
.bar-btn svg { width: 14px; height: 14px; flex-shrink: 0; }
.bar-btn .chev { width: 9px; height: 9px; }
.bar-btn .mono { font-family: var(--font-mono); }
.bar-btn .tabular { font-variant-numeric: tabular-nums; }
.bar-btn + .bar-btn { margin-left: 2px; }
.bar-btn.think { color: var(--neutral-mid); }

/* send-slot：30×30 accent 圆 */
.send-slot {
  width: var(--composer-btn-size);
  height: var(--composer-btn-size);
  margin-left: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease), opacity var(--duration-fast) var(--ease);
}
.send-slot svg { width: 16px; height: 16px; }
.send-slot:hover { background: var(--accent-hover); }
.send-slot.disabled {
  background: var(--surface-2);
  color: var(--neutral-faint);
  cursor: not-allowed;
}
</style>
