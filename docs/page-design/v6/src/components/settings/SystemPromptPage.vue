<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import UiSwitch from './UiSwitch.vue'
import { FETCHED_PI_PROMPT, APPEND_TEMPLATE, DEFAULT_APPEND, PI_DEFAULT_REF } from '@/mock/system-prompt'
import { settingsOpen, settingsPage, closeSettings, type SettingsPage } from '@/composables/useStore'

/** SystemPromptPage：两个编辑器卡（替换 / 追加系统提示词）。
 * sp-head（标题 + 副标题 + dirty badge + 启用 Switch）+ Textarea + sp-foot（计数器 + 保存/恢复/放弃）+ ref-toggle（pi 默认提示词只读参考）。*/
type CardKey = 'replace' | 'append'

interface SpState {
  key: CardKey
  title: string
  subtitle: string
  /** label 文案（textarea aria-label 同源，spec §4/§6） */
  label: string
  hint: string
  hintWarn: boolean
  enabled: boolean
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

const states = ref<SpState[]>([
  {
    key: 'replace',
    title: '替换系统提示词',
    subtitle: '完全覆盖 pi 默认的身份与指引',
    label: '自定义系统提示词',
    hint: '替换后 pi 默认的身份 / 工具列表 / 指引将被移除，工具描述需在文本中自行维护。仅对新建会话生效；关闭开关即恢复 pi 默认。',
    hintWarn: true,
    enabled: false,
    text: '',
    refOpen: false,
    everEnabled: false,
    saving: false,
    savedFlash: false,
  },
  {
    key: 'append',
    title: '注入额外提示词',
    subtitle: '在 pi 默认系统提示词后追加内容。',
    label: '追加的提示词',
    hint: '追加到系统提示词末尾，保存后下一轮对话即生效（含进行中的会话）。',
    hintWarn: false,
    enabled: true,
    text: DEFAULT_APPEND,
    refOpen: false,
    everEnabled: true,
    saving: false,
    savedFlash: false,
  },
])

/** 已保存快照（spec §2 核心设计）：初始 = mock 初值，save 成功后刷新为当前值。
 * dirty = 快照 diff（text / enabled 任一偏离即脏）。事件粘性标志已移除——
 * 净零翻转（on→off 回初始）自动回 clean；append 卡初始与快照一致 → 首屏无「未保存」误报。 */
interface SpSnapshot {
  text: string
  enabled: boolean
}
const snapshot = ref<Record<CardKey, SpSnapshot>>({
  replace: { text: '', enabled: false },
  append: { text: DEFAULT_APPEND, enabled: true },
})
const dirtyMap = computed<Record<CardKey, boolean>>(() => {
  const m: Record<CardKey, boolean> = { replace: false, append: false }
  for (const s of states.value) {
    m[s.key] = s.text !== snapshot.value[s.key].text || s.enabled !== snapshot.value[s.key].enabled
  }
  return m
})
function isDirty(s: SpState) {
  return dirtyMap.value[s.key]
}
const anyDirty = computed(() => states.value.some((s) => isDirty(s)))
const totalDirty = computed(() => states.value.filter((s) => isDirty(s)).length)
/** C5：任一卡保存中 → 两卡 Switch 均禁用（审查项：saving 窗口内 Switch 未禁用） */
const anySaving = computed(() => states.value.some((s) => s.saving))

// === 离开守卫（spec C2 三层：nav/关闭拦截 + beforeunload）===
const confirmState = ref<null | { kind: 'leave' }>(null)
const pendingLeave = ref<SettingsPage | 'close' | null>(null)
/** nav 切页 / 关闭设置 → 弹确认（放弃 = 不保存离开，页面卸载即丢弃，无需还原） */
watch(
  () => [settingsPage.value, settingsOpen.value] as const,
  ([page, open]) => {
    if (open && page === 'system-prompt') return
    if (!anyDirty.value) return
    pendingLeave.value = page !== 'system-prompt' ? page : 'close'
    settingsPage.value = 'system-prompt'
    settingsOpen.value = true
    confirmState.value = { kind: 'leave' }
  },
  // flush: 'sync' —— Vue 3.5 调度中 pre watch job 按组件 uid 排序，
  // 父组件卸载渲染先执行会 stop 子组件 watcher（回调被跳过）；
  // sync 在 closeSettings/nav select 的同步调用栈内立即拦截，卸载不发生。
  { flush: 'sync' },
)
function confirmDiscard() {
  if (!confirmState.value) return
  confirmState.value = null
  // 放弃 = 丢弃编辑态：先还原快照 → anyDirty 归零 → sync watch 重入时守卫放行导航。
  // 不还原会导致守卫拦截自己的导航（ProviderPage 同款重入 bug：弹窗永久重开）。
  for (const s of states.value) {
    const snap = snapshot.value[s.key]
    s.text = snap.text
    s.enabled = snap.enabled
    s.savedFlash = false
  }
  if (pendingLeave.value === 'close') closeSettings()
  else if (pendingLeave.value) settingsPage.value = pendingLeave.value
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (anyDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', onBeforeUnload))

/** 确认弹窗焦点初始落在「继续编辑」（default · 安全选择，spec C2） */
const guardContinueRef = ref<HTMLElement | null>(null)
watch(confirmState, (v) => {
  if (v) nextTick(() => guardContinueRef.value?.focus())
})

/** M6：复制参考区全文 + 反馈（ghost dense icon+text）。timer 按卡 key 分开存，
 * 防 1.5s 内连续复制两卡时前一卡 timer 被 clear →「已复制」永久滞留。 */
const copied = ref<Record<string, boolean>>({})
const copyTimers: Record<string, ReturnType<typeof setTimeout>> = {}
function copyRef(s: SpState) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(PI_DEFAULT_REF).catch(() => {})
  }
  copied.value[s.key] = true
  clearTimeout(copyTimers[s.key])
  copyTimers[s.key] = setTimeout(() => {
    copied.value[s.key] = false
  }, 1500)
}

/** C7：Switch 切换。首次启用（!everEnabled）→ 自动填充 pi 当前提示词作为修改起点；
 * 复启用（everEnabled）→ 不动 text（恢复历史内容）。enabled 翻转本身即脏（spec §5 snapshot diff 自动判定）。*/
function onToggle(s: SpState, checked: boolean) {
  s.enabled = checked
  s.savedFlash = false // 新编辑使「已保存」反馈失效
  if (checked && !s.everEnabled) {
    s.text = s.key === 'replace' ? FETCHED_PI_PROMPT : APPEND_TEMPLATE
    s.everEnabled = true
  }
}

function onInput(s: SpState) {
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

/** C5：保存（mock 600ms saving → 成功刷新快照 + 「已保存」1.5s 反馈）。快照刷新后 dirty 自动归零。 */
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const flashTimers: Record<string, ReturnType<typeof setTimeout>> = {}
function save(s: SpState) {
  if (!isDirty(s) || s.saving || overLimit(s)) return
  s.saving = true
  clearTimeout(saveTimers[s.key])
  saveTimers[s.key] = setTimeout(() => {
    s.saving = false
    snapshot.value[s.key] = { text: s.text, enabled: s.enabled }
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
  Object.values(copyTimers).forEach(clearTimeout)
})

function resetDefault(s: SpState) {
  // M5（spec §6）：清空 replace prompt + 关 switch——编辑操作，不直接写盘；不重置 everEnabled（spec §5）。
  // dirty 由快照 diff 自动判定：与快照一致即 clean（无变化无需保存），偏离即 dirty 待存。
  s.text = ''
  s.enabled = false
}
function discard(s: SpState) {
  // 放弃：还原快照（text/enabled 回已保存值），dirty 自动归零。不再只清标志谎称已保存。
  const snap = snapshot.value[s.key]
  s.text = snap.text
  s.enabled = snap.enabled
  s.savedFlash = false
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">系统提示词</h1>
      <p class="desc">自定义 pi 的系统提示词。可替换或追加内置提示词。</p>
      <span v-if="totalDirty" class="head-badge">{{ totalDirty }} 项未保存</span>
    </header>

    <section v-for="s in states" :key="s.key" class="sp-card">
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
          <span v-else-if="isDirty(s)" class="dirty-badge"><span class="dot"></span>未保存</span>
          <UiSwitch :checked="s.enabled" :disabled="s.saving || anySaving" :aria-label="s.title" @update:checked="onToggle(s, $event)" />
        </span>
      </div>

      <!-- body：hint + label + textarea -->
      <div class="sp-hint" :class="{ warn: s.hintWarn }">{{ s.hint }}</div>
      <label class="sp-label" :for="`sp-${s.key}-ta`">{{ s.label }}</label>
      <textarea
        :id="`sp-${s.key}-ta`"
        v-model="s.text"
        class="sp-textarea"
        :class="[s.key === 'append' ? 'sp-textarea--short' : '', { 'over-limit': overLimit(s) }]"
        :disabled="!s.enabled"
        :aria-label="s.label"
        :placeholder="s.key === 'replace' ? '输入替换后的系统提示词…' : '输入要追加的系统提示词…'"
        @input="onInput(s)"
      ></textarea>

      <!-- foot -->
      <div class="sp-foot">
        <span class="counter" :class="counterState(s)">
          <template v-if="s.key === 'replace'">
            <span class="num">{{ charCount(s).toLocaleString() }}</span> / {{ REPLACE_MAX.toLocaleString() }}
            <template v-if="counterState(s) === 'warn'"> · 接近上限</template>
            <template v-else-if="counterState(s) === 'danger'"> · 超出 {{ (charCount(s) - REPLACE_MAX).toLocaleString() }} 字符</template>
          </template>
          <template v-else>{{ charCount(s).toLocaleString() }} 字符</template>
        </span>
        <span class="spacer"></span>
        <span v-if="s.savedFlash" class="toast">
          <svg class="t-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          已保存
        </span>
        <button class="btn btn-danger btn-dense" :disabled="!isDirty(s) || s.saving" @click="discard(s)">放弃</button>
        <button v-if="s.key === 'replace'" class="btn btn-secondary btn-dense" :disabled="!isDirty(s) || s.saving" @click="resetDefault(s)">恢复默认</button>
        <button class="btn btn-default btn-dense" :disabled="!isDirty(s) || s.saving || overLimit(s)" @click="save(s)">
          <svg v-if="s.saving" class="btn-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          保存
        </button>
      </div>

      <!-- ref-toggle（m11：右箭头，展开 rotate 90°） -->
      <button class="btn btn-ghost ref-toggle" @click="s.refOpen = !s.refOpen">
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ down: s.refOpen }"><path d="m9 18 6-6-6-6"/></svg>
        {{ s.refOpen ? '隐藏' : '查看' }} pi 默认提示词
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

    <!-- 离开确认弹窗（spec C2：nav 切页 / 关闭设置拦截。内联实现，不依赖 Provider 专属 dialog） -->
    <div
      v-if="confirmState"
      class="guard-mask"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sp-guard-title"
      @click.self="confirmState = null"
      @keydown.esc="confirmState = null"
    >
      <div class="guard-dialog">
        <div class="guard-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="guard-title" id="sp-guard-title">放弃未保存的改动？</div>
        <div class="guard-desc">系统提示词有未保存的修改，离开后会丢失。可以先保存再离开，或直接放弃。</div>
        <div class="guard-actions">
          <button ref="guardContinueRef" class="btn btn-default btn-dense" @click="confirmState = null">继续编辑</button>
          <button class="btn btn-danger btn-dense" @click="confirmDiscard">放弃改动</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
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
  padding: 0 var(--space-2);
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
  padding: 0 var(--space-2);
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
  gap: var(--space-2);
  padding-top: 2px;
}
.sp-subtitle {
  margin-top: 2px;
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

/* 提示条 / label（spec §4/§6：hint neutral-mid，warn 态 warn 色；label 11px/500/dim，点 label 聚焦 textarea） */
.sp-hint {
  margin-top: var(--space-3);
  margin-bottom: var(--space-2);
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--neutral-mid);
}
.sp-hint.warn {
  color: var(--warn);
}
.sp-label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--neutral-dim);
  cursor: pointer;
}

.sp-textarea {
  width: 100%;
  min-height: 200px;
  max-height: 60vh;
  padding: 10px 12px;
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
/* spec §6：append 卡通常更短，min-height 120px（仍 resize-y 可扩） */
.sp-textarea--short {
  min-height: 120px;
}
.sp-textarea::placeholder {
  color: var(--neutral-mid);
}
/* focus：SSOT Input/Textarea 单环（inset accent-ring，border 透明，spec §7） */
.sp-textarea:focus {
  border-color: transparent;
  box-shadow: inset 0 0 0 1px var(--accent-ring);
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
  padding: 10px 14px;
  font-size: var(--text-sm);
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

/* ref-toggle（spec：ghost · w-full · 左对齐；border-top 已移除，hover 走 .btn-ghost） */
.ref-toggle {
  width: 100%;
  height: 32px;
  margin-top: var(--space-3);
  justify-content: flex-start;
  color: var(--neutral-mid);
  border-radius: var(--radius);
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
  font-size: var(--text-2xs);
  line-height: 1.6;
  color: var(--neutral-dim);
}
.copy-btn {
  flex-shrink: 0;
  font-size: var(--text-xs);
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
  max-height: 240px;
  overflow-y: auto;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-x: auto;
}

/* 离开确认弹窗（spec C2：mask + bg-card dialog + warn icon + 继续编辑/放弃改动） */
.guard-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 24px;
}
.guard-dialog {
  width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.guard-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: var(--warn-soft);
  color: var(--warn);
}
.guard-icon svg {
  width: 16px;
  height: 16px;
}
.guard-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
}
.guard-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  line-height: 1.6;
}
.guard-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
