<script setup lang="ts">
import { ref, computed } from 'vue'
import UiSwitch from './UiSwitch.vue'

/** SystemPromptPage：两个编辑器卡（替换 / 追加系统提示词）。
 * sp-head（标题 + 副标题 + dirty badge + 启用 Switch）+ Textarea + sp-foot（计数器 + 保存/恢复/放弃）+ ref-toggle（pi 默认提示词只读参考）。*/
interface SpState {
  key: 'replace' | 'append'
  title: string
  subtitle: string
  enabled: boolean
  dirty: boolean
  text: string
  refOpen: boolean
}
const DEFAULT_REPLACE = `你是 ZCode，一个交互式编码 agent。\n以单次操作完成全部任务，不要做未要求的功能。`
const DEFAULT_APPEND = `\n附加规则：\n- 优先复用现有代码而非新建\n- 修改前先理解上下文`

const states = ref<SpState[]>([
  {
    key: 'replace',
    title: '替换系统提示词',
    subtitle: '完全覆盖 pi 默认系统提示词（谨慎使用）。',
    enabled: false,
    dirty: true,
    text: DEFAULT_REPLACE,
    refOpen: false,
  },
  {
    key: 'append',
    title: '追加系统提示词',
    subtitle: '在 pi 默认系统提示词后追加内容。',
    enabled: true,
    dirty: true,
    text: DEFAULT_APPEND,
    refOpen: false,
  },
])

const PI_DEFAULT_REF = `# pi 默认系统提示词（只读参考）\n你是 pi，一个由 ZCode 驱动的 agent……\n[此处为内置系统提示词全文，仅作参考]`

/** M6：复制参考区全文 + 反馈（ghost dense icon+text） */
const copied = ref<Record<string, boolean>>({})
let copyTimer: ReturnType<typeof setTimeout> | undefined
function copyRef(s: SpState) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(PI_DEFAULT_REF).catch(() => {})
  }
  copied.value[s.key] = true
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value[s.key] = false
  }, 1500)
}

function onInput(s: SpState) {
  s.dirty = true
}
function charCount(s: SpState) {
  return s.text.length
}
function save(s: SpState) {
  s.dirty = false
}
function resetDefault(s: SpState) {
  // M5（spec §6）：清空 replace prompt + 关 switch + dirty=true——编辑操作，不直接写盘
  s.text = ''
  s.enabled = false
  s.dirty = true
}
function discard(s: SpState) {
  s.dirty = false
}

const totalDirty = computed(() => states.value.filter((s) => s.dirty).length)
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">系统提示词</h1>
      <p class="desc">自定义 pi 的系统提示词。可替换或追加内置提示词。</p>
      <span v-if="totalDirty" class="head-badge">{{ totalDirty }} 项未保存</span>
    </header>

      <section v-for="(s, idx) in states" :key="s.key" class="sp-card">
      <!-- head -->
      <div class="sp-head">
        <div class="sp-head-text">
          <div class="sp-title-row">
            <h2 class="sp-title">{{ s.title }}</h2>
            <span v-if="s.dirty" class="dirty-badge">未保存</span>
          </div>
          <p class="sp-subtitle">{{ s.subtitle }}</p>
        </div>
        <UiSwitch :checked="s.enabled" :aria-label="idx === 0 ? '替换系统提示词' : '注入额外提示词'" @update:checked="s.enabled = $event; s.dirty = true" />
      </div>

      <!-- textarea -->
      <textarea
        v-model="s.text"
        class="sp-textarea"
        :disabled="!s.enabled"
        :placeholder="s.key === 'replace' ? '输入替换后的系统提示词…' : '输入要追加的系统提示词…'"
        @input="onInput(s)"
      ></textarea>

      <!-- foot -->
      <div class="sp-foot">
        <span class="counter" :class="{ muted: !s.dirty }">{{ charCount(s) }} 字符</span>
        <span class="spacer"></span>
        <button class="btn btn-danger btn-sm" :disabled="!s.dirty" @click="discard(s)">放弃</button>
        <button v-if="s.key === 'replace'" class="btn btn-secondary btn-sm" :disabled="!s.dirty" @click="resetDefault(s)">恢复默认</button>
        <button class="btn btn-default btn-sm" :disabled="!s.dirty" @click="save(s)">保存</button>
      </div>

      <!-- ref-toggle（m11：右箭头，展开 rotate 90°） -->
      <button class="btn btn-ghost ref-toggle" @click="s.refOpen = !s.refOpen">
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ down: s.refOpen }"><path d="m9 18 6-6-6-6"/></svg>
        {{ s.refOpen ? '隐藏' : '查看' }} pi 默认提示词（只读）
      </button>
      <div v-if="s.refOpen" class="ref-wrap">
        <div class="ref-head">
          <span class="ref-note">这是 pi 的默认核心提示词（身份 + 工具列表 + 指引），仅作参考。</span>
          <button class="btn btn-ghost btn-dense copy-btn" @click="copyRef(s)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            {{ copied[s.key] ? '已复制' : '复制' }}
          </button>
        </div>
        <pre class="sp-ref">{{ PI_DEFAULT_REF }}</pre>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  z-index: var(--z-sticky);
}
.title {
  font-size: 20px;
  font-weight: 600;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
  margin-right: var(--space-4);
}
.desc {
  width: 100%;
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.head-badge {
  height: 20px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
}

.sp-card {
  background: var(--bg-card);
  border-radius: 10px;
  padding: var(--space-4);
}
.sp-card + .sp-card {
  margin-top: var(--space-4);
}
.sp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}
.sp-head-text {
  min-width: 0;
}
.sp-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sp-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--neutral-fg);
}
.dirty-badge {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
}
.sp-subtitle {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

.sp-textarea {
  width: 100%;
  min-height: 200px;
  max-height: 60vh;
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--neutral-fg);
  line-height: 1.7;
  resize: vertical;
  outline: none;
  transition: box-shadow var(--duration-fast) var(--ease);
}
.sp-textarea::placeholder {
  color: var(--neutral-mid);
}
.sp-textarea:focus {
  box-shadow: 0 0 0 1px var(--accent-ring) inset;
}
.sp-textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.sp-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.counter {
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  font-family: var(--font-mono);
}
.counter.muted {
  color: var(--neutral-dim);
}
.spacer {
  flex: 1;
}

.ref-toggle {
  width: 100%;
  height: 32px;
  margin-top: var(--space-3);
  justify-content: center;
  color: var(--neutral-mid);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  border-radius: 0;
  padding-top: var(--space-3);
}
.ref-toggle svg {
  width: 12px;
  height: 12px;
  transition: transform var(--duration-fast) var(--ease);
  transform: rotate(0deg);
}
.ref-toggle svg.down {
  /* m11：展开态右箭头 rotate 90°（朝下） */
  transform: rotate(90deg);
}
.ref-wrap {
  margin-top: var(--space-2);
}
.ref-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.ref-note {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  line-height: 1.6;
  color: var(--neutral-dim);
}
.copy-btn {
  flex-shrink: 0;
  font-size: 11px;
  height: 28px;
  padding: 0 10px;
  color: var(--neutral-mid);
}
.copy-btn svg {
  width: 13px;
  height: 13px;
}
.copy-btn:hover {
  color: var(--neutral-fg);
}
.sp-ref {
  margin-top: 0;
  padding: var(--space-3);
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-x: auto;
}
</style>
