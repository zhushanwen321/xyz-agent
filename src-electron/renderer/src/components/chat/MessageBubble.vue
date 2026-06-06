<template>
  <!-- assistant 消息：frame + 委托 AssistantContent -->
  <div
    v-if="message.role === 'assistant'"
    data-role="assistant"
    :data-entry-id="entryId"
    :data-timestamp="message.timestamp ?? ''"
    class="self-start w-full relative group/msg"
  >
    <div class="text-[10px] font-semibold uppercase tracking-[0.04em] leading-[1.4] mb-1 text-muted">
      助手
      <span v-if="message.timestamp" class="font-normal normal-case tracking-normal text-[10px] opacity-60 ml-1.5">{{ formatTime(message.timestamp) }}</span>
    </div>

    <AssistantContent :message="message" :is-streaming="isStreaming" />

    <!-- Inline actions + Branch indicator -->
    <div class="flex items-center gap-1 mt-1">
      <div class="msg-actions" :class="{ 'msg-actions--active': showActionMenu }">
        <!-- eslint-disable-next-line taste/no-native-html-elements -- inline action buttons need custom hover/opacity transitions not supported by xyz-ui Button -->
        <button class="msg-action-btn" title="复制" @click="handleCopy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          复制
        </button>
        <!-- eslint-disable-next-line taste/no-native-html-elements -- inline action buttons need custom hover/opacity transitions -->
        <button class="msg-action-btn" title="分叉" @click="handleFork">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
          分叉
        </button>
        <!-- eslint-disable-next-line taste/no-native-html-elements -- inline action buttons need custom hover/opacity transitions -->
        <button class="msg-action-btn msg-action-btn--more" title="更多" @click="onActionBtnClick">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
      <BranchIndicator
        v-if="entryId && siblingCount > 1"
        :entry-id="entryId"
        :sibling-count="siblingCount"
        :branch-tabs="branchTabs"
        @navigate="$emit('navigate', $event)"
      />
    </div>
  </div>

  <!-- user 消息：标签在气泡外面 -->
  <div
    v-else
    data-role="user"
    :data-entry-id="entryId"
    :data-timestamp="message.timestamp ?? ''"
    class="self-stretch relative group/msg"
  >
    <div class="text-[10px] font-semibold uppercase tracking-[0.04em] leading-[1.4] mb-[3px] text-right text-muted">
      <span v-if="message.timestamp" class="font-normal normal-case tracking-normal text-[10px] opacity-60 mr-1.5">{{ formatTime(message.timestamp) }}</span>
      用户
    </div>
    <!-- User bubble: skill-link embedded inline when skill is present -->
    <div v-if="displayContent" class="py-2 px-3 leading-[1.6] text-xs text-fg rounded-sm msg-user-bubble">
      <div
        class="msg__body select-text"
        :data-message-id="message.id"
        :data-markdown-source="displayContent"
        @click="handleBodyClick"
      >
        <!-- Inline skill link (Codex-style) -->
        <a
          v-if="resolvedSkillName"
          class="skill-link"
          :class="{ 'skill-link--active': skillDrawerOpen }"
          @click.stop="handleSkillLinkClick"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2H12.5A1.5 1.5 0 0114 3.5V12.5A1.5 1.5 0 0112.5 14H3.5A1.5 1.5 0 012 12.5V3.5A1.5 1.5 0 013.5 2Z"/><path d="M8 2v12"/><path d="M2 8h6"/></svg>
          {{ resolvedSkillName }}
        </a>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span v-html="renderedContent"></span>
      </div>
    </div>

    <!-- Inline actions (right-aligned for user) + Branch indicator -->
    <div class="flex items-center justify-end gap-1 mt-1">
      <div class="msg-actions" :class="{ 'msg-actions--active': showActionMenu }">
        <!-- eslint-disable-next-line taste/no-native-html-elements -- inline action buttons need custom hover/opacity transitions not supported by xyz-ui Button -->
        <button class="msg-action-btn" title="复制" @click="handleCopy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          复制
        </button>
        <!-- eslint-disable-next-line taste/no-native-html-elements -- inline action buttons need custom hover/opacity transitions -->
        <button class="msg-action-btn" title="编辑" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          编辑
        </button>
        <!-- eslint-disable-next-line taste/no-native-html-elements -- inline action buttons need custom hover/opacity transitions -->
        <button class="msg-action-btn msg-action-btn--more" title="更多" @click="onActionBtnClick">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>
      <BranchIndicator
        v-if="entryId && siblingCount > 1"
        :entry-id="entryId"
        :sibling-count="siblingCount"
        :branch-tabs="branchTabs"
        @navigate="$emit('navigate', $event)"
      />
    </div>
  </div>

  <!-- Action menu (shared for both roles) -->
  <MessageActionMenu
    v-if="message.role !== 'system'"
    :entry-id="entryId"
    :session-id="sessionId"
    :message="message"
    :format="'markdown'"
    :visible="showActionMenu"
    :anchor-rect="actionMenuAnchor"
    @close="closeActionMenu"
    @navigate="$emit('navigate', $event)"
  />

  <!-- Batch selection checkbox (rendered as sibling overlay) -->
  <!-- eslint-disable-next-line taste/no-native-html-elements -- compact batch-mode checkbox overlay -->
  <div v-if="selectable" class="msg-batch-checkbox" @click.stop>
    <!-- eslint-disable-next-line taste/no-native-html-elements -->
    <input
      type="checkbox"
      class="msg-batch-checkbox__input"
      :checked="selected"
      :aria-label="selected ? '取消选择' : '选择消息'"
      @change="$emit('toggle-select')"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Message } from '@xyz-agent/shared'
import type { BranchTab } from '../../stores/tree'
import { copyWithToast } from '../../lib/clipboard'
import { collectMessageContent } from '../../lib/collectMessageContent'
import { useTree } from '../../composables/useTree'
import { useMarkdownRender } from '../../composables/useMarkdownRender'
import { useMarkdownBodyClick } from '../../composables/useMarkdownBodyClick'
import AssistantContent from './AssistantContent.vue'
import MessageActionMenu from './MessageActionMenu.vue'
import BranchIndicator from './BranchIndicator.vue'

const props = withDefaults(defineProps<{
  message: Message
  isStreaming?: boolean
  entryId?: string
  sessionId?: string
  siblingCount?: number
  selectable?: boolean
  selected?: boolean
  branchTabs?: BranchTab[]
  skillDrawerOpen?: boolean}>(), {
  entryId: '',
  sessionId: '',
  siblingCount: 0,
  selectable: false,
  selected: false,
  branchTabs: () => [],
  skillDrawerOpen: false,})

const emit = defineEmits<{
  'open-skill': [payload: { name: string; location?: string }]
  navigate: [targetEntryId: string]
  'toggle-select': []
}>()

// ── Action menu state ──
const showActionMenu = ref(false)
const actionMenuAnchor = ref<DOMRect | null>(null)

// ── Skill display logic ──
// For real-time messages: content has "/skill:xxx" prefix
// For history messages: message-converter already stripped the <skill> block
const resolvedSkillName = computed(() => {
  if (props.message.skillName) return props.message.skillName
  // Fallback: detect /skill: prefix in content (real-time messages)
  const match = props.message.content?.match(/^\/skill:([^\s]+)(?:\s|$)/)
  return match ? match[1] : undefined
})

const displayContent = computed(() => {
  if (!resolvedSkillName.value) return props.message.content
  // History messages: converter already stripped <skill> block
  if (props.message.skillName) return props.message.content
  // Real-time messages: strip /skill:xxx prefix
  return props.message.content?.replace(/^\/skill:[^\s]+\s*/, '').trim() || ''
})

function handleSkillLinkClick() {
  emit("open-skill", {
    name: resolvedSkillName.value!,
    location: props.message.skillLocation,
  })
}

function onActionBtnClick(e: MouseEvent) {
  const btn = e.currentTarget as HTMLElement
  actionMenuAnchor.value = btn.getBoundingClientRect()
  showActionMenu.value = !showActionMenu.value
}

function closeActionMenu() {
  showActionMenu.value = false
}

// ── Inline action handlers ──
const { fork } = useTree()

function getMessageEl(): HTMLElement | null {
  return document.querySelector(`[data-entry-id="${props.entryId}"]`)
    ?? document.querySelector(`[data-message-id="${props.message.id}"]`)
    ?? null
}

async function handleCopy() {
  const el = getMessageEl()
  if (!el) return
  const text = collectMessageContent(el, { format: 'markdown' })
  await copyWithToast(text, { format: 'markdown' })
}

function handleFork() {
  if (props.sessionId && props.entryId) {
    fork(props.sessionId, props.entryId)
  }
}

// ── ContentBlocks 查找辅助 ──

function formatTime(ts: number): string {
  const PAD_WIDTH = 2
  const d = new Date(ts)
  const h = d.getHours().toString().padStart(PAD_WIDTH, '0')
  const m = d.getMinutes().toString().padStart(PAD_WIDTH, '0')
  return `${h}:${m}`
}

// ── Markdown rendering (user bubble) ──
const { renderedContent } = useMarkdownRender(
  () => displayContent.value,
  {
    messageId: () => props.message.id,
    status: () => props.message.status,
    forceDarkCode: props.message.role === 'user',
  },
)

// ── 事件委托：复制 + 折叠 + 外部链接 (shared composable) ──
const { handleBodyClick } = useMarkdownBodyClick()
</script>

<!-- msg__body 内的元素由 v-html 渲染，这些样式已移至 style.css -->
<style scoped>
/* msg__body 内的元素由 v-html 渲染，无法用 Tailwind 类作用于动态内容 */
/* 所有样式已移至 style.css，如在此处添加样式请确保 style.css 同步更新 */

/* Inline action bar: appears on hover */
.msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.group\/msg:hover .msg-actions {
  opacity: 1;
}
.msg-actions--active {
  opacity: 1 !important;
}
.msg-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-family: var(--font-body);
  cursor: pointer;
  border-radius: var(--radius);
  transition: all 0.12s ease;
  line-height: 1;
}
.msg-action-btn svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.msg-action-btn:hover {
  background: var(--hover-bg);
  color: var(--fg);
}
.msg-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.msg-action-btn:disabled:hover {
  background: transparent;
  color: var(--muted);
}
.msg-action-btn--more {
  padding: 3px 5px;
}
.msg-action-btn--more svg {
  width: 14px;
  height: 14px;
}

/* Batch selection checkbox */
.msg-batch-checkbox {
  position: absolute;
  top: 2px;
  left: -28px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 11;
  cursor: pointer;
}
.msg-batch-checkbox__input {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--accent);
}
/* Batch selection checkbox styles remain */

/* Skill link (inline, Codex-style) */
.skill-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  border-bottom: 1px solid color-mix(in oklch, var(--accent) 40%, transparent);
  transition: border-color 0.12s, background 0.12s;
  vertical-align: baseline;
  white-space: nowrap;
  margin-right: 4px;
}
.skill-link:hover {
  border-bottom-color: var(--accent);
}
.skill-link svg {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  opacity: 0.7;
}
.skill-link--active {
  background: var(--accent);
  color: white;
  padding: 0 3px;
  border-radius: 1px;
  border-bottom: none;
}
.skill-link--active svg {
  opacity: 1;
}
.msg-user-bubble {
  background: var(--user-bubble-bg);
  border: 1px solid var(--user-bubble-border);
}
</style>
