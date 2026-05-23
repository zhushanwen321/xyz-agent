<template>
  <!-- system 消息：全宽横幅 -->
  <div
    v-if="message.role === 'system'"
    :class="[
      'self-stretch w-full max-w-none my-2 border border-border bg-surface rounded-none px-3.5 py-2.5 text-[13px] flex items-start gap-2.5 box-border',
      message.status === 'error' && 'border-danger bg-danger-light',
    ]"
  >
    <span
      :class="[
        'w-2 h-2 rounded-full shrink-0 mt-1',
        message.status === 'error' ? 'bg-danger' : 'bg-success',
      ]"
    ></span>
    <div class="flex-1">
      <div class="font-semibold text-[13px]">{{ message.content }}</div>
    </div>
  </div>

  <!-- assistant 消息：标签在外面，thinking/tool 在外面，只有 text 在气泡中 -->
  <div
    v-else-if="message.role === 'assistant'"
    data-role="assistant"
    class="self-start w-full"
  >
    <div class="text-[10px] font-semibold uppercase tracking-[0.04em] leading-[1.4] mb-1 text-muted">
      助手
      <span v-if="message.timestamp" class="font-normal normal-case tracking-normal text-[10px] opacity-60 ml-1.5">{{ formatTime(message.timestamp) }}</span>
    </div>

    <!-- 有序渲染：按 contentBlocks 顺序 -->
    <template v-if="message.contentBlocks?.length">
      <template v-for="block in message.contentBlocks" :key="block.refId">
        <!-- Thinking block (outside bubble) -->
        <ThinkingBlock
          v-if="block.type === 'thinking'"
          :text="getThinkingContent(block.refId)"
          :streaming="message.status === 'streaming'"
        />
        <!-- Tool call card (outside bubble) -->
        <ToolCallCard
          v-else-if="block.type === 'toolCall'"
          :tool-call="getToolCall(block.refId)!"
          :batch-info="batchInfoMap.get(block.refId)"
        />
        <!-- Text content (inside bubble) -->
        <div
          v-else-if="block.type === 'text' && message.content"
          class="py-3 px-4 leading-[1.6] text-sm bg-surface border-l-2 border-border rounded-sm"
        >
          <div
            class="msg__body select-text"
            :data-message-id="message.id"
            @click="handleBodyClick"
          >
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span v-html="renderedContent"></span>
            <span v-if="isStreaming" class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"></span>
          </div>
        </div>
      </template>
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
        class="py-3 px-4 leading-[1.6] text-sm bg-surface border-l-2 border-border rounded-sm"
      >
        <div
          class="msg__body select-text"
          :data-message-id="message.id"
          @click="handleBodyClick"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-html="renderedContent"></span>
          <span v-if="isStreaming" class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"></span>
        </div>
      </div>
    </template>
  </div>

  <!-- user 消息：标签在气泡外面 -->
  <div
    v-else
    data-role="user"
    class="self-end max-w-[75%]"
  >
    <div class="text-[10px] font-semibold uppercase tracking-[0.04em] leading-[1.4] mb-[3px] text-right text-muted">
      <span v-if="message.timestamp" class="font-normal normal-case tracking-normal text-[10px] opacity-60 mr-1.5">{{ formatTime(message.timestamp) }}</span>
      用户
    </div>
    <div class="py-3 px-4 leading-[1.6] text-sm bg-surface text-fg border-l-2 border-accent rounded-sm">
      <div
        v-if="message.content"
        class="msg__body select-text"
        :data-message-id="message.id"
        @click="handleBodyClick"
      >
        <span
          v-if="message.skillName"
          class="inline-flex items-center gap-0.5 text-[11px] font-medium py-[1px] px-1.5 rounded-full bg-[var(--white-25)] text-white mr-1 align-middle leading-[1.4]"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10"><path d="M2 8l4 4 8-8"/></svg>
          {{ message.skillName }}
        </span>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span v-html="renderedContent"></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { Message } from '@xyz-agent/shared'
import type { BatchInfo } from './ToolCallCard.vue'
import { renderLightweight, renderFull } from '../../lib/markdown'
import { useSettingsStore } from '../../stores/settings'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ message: Message; isStreaming?: boolean }>()
const settings = useSettingsStore()

const COPY_FEEDBACK_MS = 1500
const BYTES_PER_KB = 1024
const MIN_TOOL_CALLS = 2
const BATCH_MIN_SIZE = 2

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
const lightweightContent = computed(() => renderLightweight(props.message.content))

// 最终输出：流式用轻量，完成用缓存
const renderedContent = computed(() => {
  if (props.message.status === 'streaming') {
    return lightweightContent.value
  }
  return fullRenderCache.value || lightweightContent.value
})

// 版本号防止竞态：组件级闭包，避免多实例共享
let renderVersion = 0

// Mermaid 模块级单例（动态导入，延迟初始化）
let mermaidModule: typeof import('mermaid').default | null = null
// 记录上次初始化时的主题，切换后需重新初始化
let mermaidInitTheme: string | null = null

// 监听 content/status/theme 变化，触发完整渲染
watch(
  () => [props.message.content, props.message.status, settings.theme] as const,
  async ([content, status]) => {
    if (status !== 'streaming' && content) {
      const version = ++renderVersion
      const effectiveTheme = getEffectiveTheme()
      try {
        const result = await renderFull(content, effectiveTheme)
        if (version === renderVersion) {
          fullRenderCache.value = result
        }
      } catch {
        if (version === renderVersion) {
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
</style>
