<template>
  <!-- assistant 消息：section 分组（thinking / tool / text） -->
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

    <!-- Section-grouped rendering (contentBlocks available) -->
    <template v-if="assistantSections.length">
      <div
        v-for="(section, si) in assistantSections"
        :key="si"
        class="asst-section"
      >
        <!-- Section label: only show for tool groups with 2+ calls (ThinkingBlock has its own header) -->
        <div v-if="section.type === 'toolCall' && toolCallCount > 1" class="asst-section__label">
          <span class="asst-section__dot asst-section__dot--tool"></span>
          {{ toolCallCount }} 次工具调用
        </div>
        <!-- Text section gets a subtle dot to mark "final answer" -->
        <div v-else-if="section.type === 'text'" class="asst-section__label">
          <span class="asst-section__dot asst-section__dot--text"></span>
          回答
        </div>

        <!-- Thinking blocks -->
        <template v-if="section.type === 'thinking'">
          <ThinkingBlock
            v-for="block in section.blocks"
            :key="block.refId"
            :text="getThinkingContent(block.refId)"
            :streaming="message.status === 'streaming'"
          />
        </template>

        <!-- Tool call blocks -->
        <template v-else-if="section.type === 'toolCall'">
          <ToolCallCard
            v-for="block in section.blocks"
            :key="block.refId"
            :tool-call="getToolCall(block.refId)!"
            :batch-info="batchInfoMap.get(block.refId)"
          />
        </template>

        <!-- Text block -->
        <template v-else-if="section.type === 'text' && message.content">
          <div
            class="py-2 px-3 leading-[1.6] text-xs rounded-sm"
            style="background:var(--msg-assistant-bg)"
          >
            <div
              class="msg__body select-text"
              :data-message-id="message.id"
              :data-markdown-source="message.content"
              @click="handleBodyClick"
            >
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span v-html="renderedContent"></span>
              <span v-if="isStreaming" class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"></span>
            </div>
          </div>
        </template>
      </div>
    </template>

    <!-- Fallback: 无 contentBlocks 时用固定顺序（历史消息兼容） -->
    <template v-else>
      <ThinkingBlock
        v-for="block in message.thinking"
        :key="block.id"
        :text="block.content"
        :streaming="message.status === 'streaming'"
      />
      <ToolCallCard
        v-for="tc in message.toolCalls"
        :key="tc.id"
        :tool-call="tc"
        :batch-info="batchInfoMap.get(tc.id)"
      />
      <div
        v-if="message.content"
        class="py-2 px-3 leading-[1.6] text-xs border-t border-transparent rounded-sm"
        style="background:var(--msg-assistant-bg)"
      >
        <div
          class="msg__body select-text"
          :data-message-id="message.id"
          :data-markdown-source="message.content"
          @click="handleBodyClick"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-html="renderedContent"></span>
          <span v-if="isStreaming" class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"></span>
        </div>
      </div>
    </template>

    <!-- Inline actions + Branch indicator -->
    <div class="flex items-center gap-1 mt-1">
      <div class="msg-actions" :class="{ 'msg-actions--active': showActionMenu }">
        <button class="msg-action-btn" title="复制" @click="handleCopy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          复制
        </button>
        <button class="msg-action-btn" title="分叉" @click="handleFork">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
          分叉
        </button>
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
    <div v-if="displayContent" class="py-2 px-3 leading-[1.6] text-xs text-fg rounded-sm" style="background:var(--user-bubble-bg);border:1px solid var(--user-bubble-border);">
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
        <button class="msg-action-btn" title="复制" @click="handleCopy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          复制
        </button>
        <button class="msg-action-btn" title="编辑" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          编辑
        </button>
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
import { ref, computed, watch, nextTick } from 'vue'
import type { Message, ContentBlock } from '@xyz-agent/shared'
import type { BatchInfo } from './ToolCallCard.vue'
import type { BranchTab } from '../../stores/tree'
import { renderLightweight, renderFull } from '../../lib/markdown'
import { useSettingsStore } from '../../stores/settings'
import { copyWithToast } from '../../lib/clipboard'
import { collectMessageContent } from '../../lib/collectMessageContent'
import { useTree } from '../../composables/useTree'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'
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

const settings = useSettingsStore()

const COPY_FEEDBACK_MS = 1500
const BYTES_PER_KB = 1024
const MIN_TOOL_CALLS = 2
const BATCH_MIN_SIZE = 2

// ── Section grouping for assistant content blocks ──
type SectionType = 'thinking' | 'toolCall' | 'text'

interface AssistantSection {
  type: SectionType
  blocks: ContentBlock[]
}

/** Merge adjacent same-type contentBlocks into sections */
const assistantSections = computed<AssistantSection[]>(() => {
  const blocks = props.message.contentBlocks
  if (!blocks?.length) return []
  const sections: AssistantSection[] = []
  let current: AssistantSection | null = null

  for (const block of blocks) {
    // Treat 'text' blocks without content as skip
    if (block.type === 'text' && !props.message.content) continue

    if (current && current.type === block.type) {
      current.blocks.push(block)
    } else {
      if (current) sections.push(current)
      current = { type: block.type as SectionType, blocks: [block] }
    }
  }
  if (current) sections.push(current)
  return sections
})

const toolCallCount = computed(() =>
  props.message.toolCalls?.length ?? 0
)

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

function getThinkingContent(refId: string): string {
  return props.message.thinking?.find(b => b.id === refId)?.content ?? ''
}

function getToolCall(refId: string): import('@xyz-agent/shared').ToolCall | undefined {
  return props.message.toolCalls?.find(tc => tc.id === refId)
}

// 完整渲染缓存（renderFull 是异步的）
const fullRenderCache = ref('')

// 流式阶段直接用轻量渲染
const lightweightContent = computed(() => renderLightweight(displayContent.value))

// 最终输出：流式用轻量，完成用缓存
const renderedContent = computed(() => {
  if (props.message.status === 'streaming') {
    return lightweightContent.value
  }
  return fullRenderCache.value || lightweightContent.value
})

// 版本号防止竞态：组件级闭包，避免多实例共享
const renderVersion = ref(0)

// Mermaid 模块级单例（动态导入，延迟初始化）
let mermaidModule: typeof import('mermaid').default | null = null
// 记录上次初始化时的主题，切换后需重新初始化
let mermaidInitTheme: string | null = null

// 监听 content/status/theme 变化，触发完整渲染
watch(
  () => [displayContent.value, props.message.status, settings.theme] as const,
  async ([content, status]) => {
    if (status !== 'streaming' && content) {
      renderVersion.value++
      const version = renderVersion.value
      const effectiveTheme = getEffectiveTheme()
      // 用户气泡始终为深色背景：不论 app 主题，都使用 dark Shiki 主题保证代码可读
      const codeTheme: 'light' | 'dark' | undefined =
        props.message.role === 'user' ? 'dark' : undefined
      try {
        const result = await renderFull(content, effectiveTheme, { codeTheme })
        if (version === renderVersion.value) {
          fullRenderCache.value = result
        }
      } catch {
        if (version === renderVersion.value) {
          // fallback 到轻量渲染
          fullRenderCache.value = renderLightweight(content)
        }
      }
      await nextTick()
      renderMermaidBlocks()
    }
  },
  { immediate: true },
)

// ── Mermaid 懒加载渲染 ──

/** 获取当前实际主题（解析 system 为 light/dark） */
function getEffectiveTheme(): 'light' | 'dark' {
  if (settings.theme === 'dark') return 'dark'
  if (settings.theme === 'light') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

async function renderMermaidBlocks() {
  const el = document.querySelector(`[data-message-id="${props.message.id}"] .mermaid-source[data-mermaid]`)
  if (!el) return

  try {
    if (!mermaidModule) {
      mermaidModule = (await import('mermaid')).default
    }
    const effectiveTheme = getEffectiveTheme()
    // 首次初始化或主题切换后需重新初始化
    if (mermaidInitTheme !== effectiveTheme) {
      mermaidModule.initialize({
        startOnLoad: false,
        securityLevel: 'sandbox',
        theme: effectiveTheme === 'dark' ? 'dark' : 'default',
      })
      mermaidInitTheme = effectiveTheme
    }
    const sources = document.querySelectorAll(`[data-message-id="${props.message.id}"] .mermaid-source[data-mermaid]`)
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]
      const content = source.textContent ?? ''
      // 消息级唯一 ID：messageId + 索引 + 时间戳，避免跨实例/跨 tick 冲突
      const mermaidId = `mermaid-${props.message.id}-${i}-${Date.now()}`
      const { svg } = await mermaidModule.render(mermaidId, content)
      source.innerHTML = svg
      source.removeAttribute('data-mermaid')
      source.classList.remove('mermaid-source')
      source.classList.add('mermaid-rendered')
    }
  } catch {
    // Mermaid 渲染失败，fallback 显示原文 + 错误提示
    const sources = document.querySelectorAll(`[data-message-id="${props.message.id}"] .mermaid-source[data-mermaid]`)
    sources.forEach(source => {
      source.classList.add('mermaid-error')
      const errorEl = document.createElement('div')
      errorEl.className = 'mermaid-error-msg'
      errorEl.textContent = '图表渲染失败'
      source.parentElement?.insertBefore(errorEl, source)
    })
  }
}

// ── 事件委托：复制 + 折叠 ──
async function handleBodyClick(e: MouseEvent) {
  const target = e.target as HTMLElement

  // 外部链接：在默认浏览器打开
  const anchor = target.closest('a')
  if (anchor instanceof HTMLAnchorElement) {
    const href = anchor.href
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault()
      window.electronAPI?.openExternal(href)
    }
    return
  }

  // 复制按钮
  if (target.matches('.code-copy-btn')) {
    e.preventDefault()
    const codeBlock = target.closest('.code-block')
    const codeEl = codeBlock?.querySelector('pre code') ?? codeBlock?.querySelector('code')
    const code = codeEl?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(code)
      target.textContent = '已复制'
      setTimeout(() => { target.textContent = '复制' }, COPY_FEEDBACK_MS)
    } catch {
      target.textContent = '复制失败'
      setTimeout(() => { target.textContent = '复制' }, COPY_FEEDBACK_MS)
    }
    return
  }

  // 折叠/展开按钮
  if (target.matches('.code-expand-btn')) {
    e.preventDefault()
    const codeBlock = target.closest('.code-block')
    if (!codeBlock) return
    const isCollapsed = codeBlock.getAttribute('data-collapsed') === 'true'
    codeBlock.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true')
    target.textContent = isCollapsed ? '收起' : '展开'
  }
}

// ── Batch detection: consecutive same-type file operations ──
function extractContentSize(input: unknown): number {
  if (!input) return 0
  try {
    const obj = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>
    const text = obj.content ?? obj.new_text ?? ''
    return String(text).length
  } catch { return 0 }
}

function formatBatchSize(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < BYTES_PER_KB) return `${bytes}B`
  if (bytes < BYTES_PER_KB * BYTES_PER_KB) return `${(bytes / BYTES_PER_KB).toFixed(1)}KB`
  return `${(bytes / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)}MB`
}

const batchInfoMap = computed(() => {
  const result = new Map<string, BatchInfo>()
  const toolCalls = props.message.toolCalls
  if (!toolCalls || toolCalls.length < MIN_TOOL_CALLS) return result


  let batchStart = 0
  for (let i = 1; i <= toolCalls.length; i++) {
    const isEnd = i === toolCalls.length || toolCalls[i].toolName !== toolCalls[batchStart].toolName
    if (isEnd) {
      const size = i - batchStart
      // Only group file operation batches (write, edit)
      const name = toolCalls[batchStart].toolName
      if (size >= BATCH_MIN_SIZE && (name === 'write' || name === 'edit')) {
        let totalBytes = 0
        for (let j = batchStart; j < i; j++) {
          totalBytes += extractContentSize(toolCalls[j].input)
        }
        const totalSize = formatBatchSize(totalBytes)
        for (let j = batchStart; j < i; j++) {
          result.set(toolCalls[j].id, {
            index: j - batchStart,
            total: size,
            isLast: j === i - 1,
            totalSize,
          })
        }
      }
      batchStart = i
    }
  }
  return result
})
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
}</style>
