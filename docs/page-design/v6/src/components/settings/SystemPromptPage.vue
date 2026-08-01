<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
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
  /** C7：历史是否启用过自定义提示词（一经 true 不回退，判定「首次启用」的 SSOT） */
  everEnabled: boolean
  /** C5：保存中（Save disabled + spinner + badge 变「保存中」） */
  saving: boolean
  /** C5：保存成功「已保存」反馈（1.5s 后消失） */
  savedFlash: boolean
}

/** C4：replace 卡字符上限（spec §7 · SYSTEM_PROMPT_MAX_LENGTH 对齐 runtime） */
const REPLACE_MAX = 16000
/** C4：warn 阈值（spec §7：normal <90% / warn 90-100% / danger >100%） */
const REPLACE_WARN_AT = REPLACE_MAX * 0.9

/** C7：mock 拉取 pi 当前生效系统提示词（首次启用填充的修改起点） */
const FETCHED_PI_PROMPT = `你是 pi，一个交互式编码 agent。\n你通过读写文件、执行命令、编辑代码来帮助用户完成任务。\n保持回复简洁，明确展示文件路径。`
/** C7：append 卡首次启用模板（追加无默认全文，模板更轻，spec §5） */
const APPEND_TEMPLATE = `请遵循以下额外指引：\n- 回答前先阅读相关文件\n- 修改涉及多文件时先列出改动清单`
const DEFAULT_APPEND = `\n附加规则：\n- 优先复用现有代码而非新建\n- 修改前先理解上下文`

const states = ref<SpState[]>([
  {
    key: 'replace',
    title: '替换系统提示词',
    subtitle: '完全覆盖 pi 默认系统提示词（谨慎使用）。',
    enabled: false,
    dirty: false,
    text: '',
    refOpen: false,
    everEnabled: false,
    saving: false,
    savedFlash: false,
  },
  {
    key: 'append',
    title: '追加系统提示词',
    subtitle: '在 pi 默认系统提示词后追加内容。',
    enabled: true,
    dirty: true,
    text: DEFAULT_APPEND,
    refOpen: false,
    everEnabled: true,
    saving: false,
    savedFlash: false,
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

/** C7：Switch 切换。首次启用（!everEnabled）→ 自动填充 pi 当前提示词作为修改起点 + dirty=true；
 * 复启用（everEnabled）→ 不动 text（恢复历史内容）。enabled 翻转本身即脏（spec §5 snapshot diff）。*/
function onToggle(s: SpState, checked: boolean) {
  s.enabled = checked
  if (checked && !s.everEnabled) {
    s.text = s.key === 'replace' ? FETCHED_PI_PROMPT : APPEND_TEMPLATE
    s.everEnabled = true
  }
  s.dirty = true
}

function onInput(s: SpState) {
  s.dirty = true
  s.savedFlash = false // 新编辑使「已保存」反馈失效
}
function charCount(s: SpState) {
  return s.text.length
}

/** C4：计数器三态（仅 replace 卡有上限；append 无上限不进三态，spec §7） */
function counterState(s: SpState): 'normal' | 'warn' | 'danger' {
  if (s.key !== 'replace') return 'normal'
  const len = s.text.length
  if (len > REPLACE_MAX) return 'danger'
  if (len >= REPLACE_WARN_AT) return 'warn'
  return 'normal'
}
function overLimit(s: SpState) {
  return counterState(s) === 'danger'
}

/** C5：保存（mock 600ms saving → 成功清 dirty + 「已保存」1.5s 反馈） */
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const flashTimers: Record<string, ReturnType<typeof setTimeout>> = {}
function save(s: SpState) {
  if (!s.dirty || s.saving || overLimit(s)) return
  s.saving = true
  clearTimeout(saveTimers[s.key])
  saveTimers[s.key] = setTimeout(() => {
    s.saving = false
    s.dirty = false
    s.savedFlash = true
    clearTimeout(flashTimers[s.key])
    flashTimers[s.key] = setTimeout(() => {
      s.savedFlash = false
    }, 1500)
  }, 600)
}
onUnmounted(() => {
  Object.values(saveTimers).forEach(clearTimeout)
  Object.values(flashTimers).forEach(clearTimeout)
})

function resetDefault(s: SpState) {
  // M5（spec §6）：清空 replace prompt + 关 switch + dirty=true——编辑操作，不直接写盘；不重置 everEnabled（spec §5）
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
          </div>
          <p class="sp-subtitle">{{ s.subtitle }}</p>
        </div>
        <span class="sp-head-ctrl">
          <span v-if="s.saving" class="dirty-badge saving"><span class="spin"></span>保存中</span>
          <span v-else-if="s.dirty" class="dirty-badge"><span class="dot"></span>未保存</span>
          <UiSwitch :checked="s.enabled" :aria-label="idx === 0 ? '替换系统提示词' : '注入额外提示词'" @update:checked="onToggle(s, $event)" />
        </span>
      </div>

      <!-- textarea -->
      <textarea
        v-model="s.text"
        class="sp-textarea"
        :class="{ 'over-limit': overLimit(s) }"
        :disabled="!s.enabled"
        :placeholder="s.key === 'replace' ? '输入替换后的系统提示词…' : '输入要追加的系统提示词…'"
        @input="onInput(s)"
      ></textarea>

      <!-- foot -->
      <div class="sp-foot">
        <span class="counter" :class="[counterState(s), { muted: !s.dirty }]">
          <template v-if="s.key === 'replace'">
            <span class="num">{{ charCount(s).toLocaleString() }}</span> / {{ REPLACE_MAX.toLocaleString() }}
            <template v-if="counterState(s) === 'warn'"> · 接近上限</template>
            <template v-else-if="counterState(s) === 'danger'"> · 超出 {{ (charCount(s) - REPLACE_MAX).toLocaleString() }} 字符</template>
          </template>
          <template v-else>{{ charCount(s) }} 字符</template>
        </span>
        <span class="spacer"></span>
        <span v-if="s.savedFlash" class="toast">
          <svg class="t-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          已保存
        </span>
        <button class="btn btn-danger btn-sm" :disabled="!s.dirty || s.saving" @click="discard(s)">放弃</button>
        <button v-if="s.key === 'replace'" class="btn btn-secondary btn-sm" :disabled="!s.dirty || s.saving" @click="resetDefault(s)">恢复默认</button>
        <button class="btn btn-default btn-sm" :disabled="!s.dirty || s.saving || overLimit(s)" @click="save(s)">
          <svg v-if="s.saving" class="btn-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          保存
        </button>
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
  gap: 5px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
}
.dirty-badge .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
/* C5：保存中态（spec §7：accent-soft 底 + accent 字 + 行内 spinner） */
.dirty-badge.saving {
  background: var(--accent-soft);
  color: var(--accent);
}
.sp-head-ctrl {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
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
  opacity: 0.5;
  cursor: not-allowed;
  resize: none;
}
/* C4：超限态 danger 边框（spec §7：border danger + focus 内环 danger，同 SSOT Input.err 范式） */
.sp-textarea.over-limit {
  border-color: var(--danger);
}
.sp-textarea.over-limit:focus {
  border-color: transparent;
  box-shadow: inset 0 0 0 1px var(--danger);
}

.sp-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.counter {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  font-family: var(--font-mono);
  white-space: nowrap;
}
.counter .num {
  color: var(--neutral-mid);
}
/* C4：三态色（spec §7：warn 90-100% / danger >100%，数字同色） */
.counter.warn {
  color: var(--warn);
}
.counter.warn .num {
  color: var(--warn);
}
.counter.danger {
  color: var(--danger);
}
.counter.danger .num {
  color: var(--danger);
}
.spacer {
  flex: 1;
}
.sp-foot {
  position: relative;
}
/* C5：保存成功反馈（spec §7 toast：bg-elevated + border-strong + shadow，浮在 foot 上方右侧） */
.toast {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  padding: 8px 12px;
  font-size: 12px;
  color: var(--neutral-fg);
}
.toast .t-ico {
  width: 15px;
  height: 15px;
  color: var(--success);
  flex-shrink: 0;
}
/* spinner（保存中：按钮内 13px / badge 内 9px，spec §7） */
.btn-spin {
  width: 13px;
  height: 13px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.spin {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .btn-spin,
  .spin {
    animation: none;
  }
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
