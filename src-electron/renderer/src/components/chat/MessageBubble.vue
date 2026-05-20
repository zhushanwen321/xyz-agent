<template>
  <!-- system 消息：全宽横幅 -->
  <div
    v-if="message.role === 'system'"
    :class="[
      'self-stretch w-full max-w-none my-2 border border-border bg-surface rounded-sm px-3.5 py-2.5 text-[13px] flex items-start gap-2.5 box-border',
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

  <!-- assistant / user 消息 -->
  <div
    v-else
    :data-role="message.role"
    :class="[
      'py-3 px-4 leading-[1.6] text-sm',
      message.role === 'user'
        ? 'self-end max-w-[75%] bg-accent text-white rounded rounded-br-xs'
        : 'self-start w-full bg-transparent',
    ]"
  >
    <div
      :class="[
        'text-[10px] font-semibold uppercase tracking-[0.04em] leading-[1.4] mb-[3px]',
        message.role === 'user' ? 'text-right text-[var(--white-70)]' : 'text-muted',
      ]"
    >
      <template v-if="message.role === 'assistant'">助手</template>
      <template v-else>用户</template>
    </div>

    <!-- Thinking blocks -->
    <ThinkingBlock
      v-for="block in message.thinking"
      :key="block.id"
      :text="block.content"
      :streaming="message.status === 'streaming'"
      :collapsed="block.collapsed"
    />

    <!-- Tool call cards -->
    <ToolCallCard
      v-for="tc in message.toolCalls"
      :key="tc.id"
      :tool-call="tc"
      :batch-info="batchInfoMap.get(tc.id)"
    />

    <!-- Markdown content -->
    <div
      v-if="message.content"
      class="msg__body select-text"
      :data-message-id="message.id"
      @click="handleBodyClick"
    >
      <span
        v-if="message.role === 'user' && message.skillName"
        class="inline-flex items-center gap-0.5 text-[11px] font-medium py-[1px] px-1.5 rounded-full bg-[var(--white-25)] text-white mr-1 align-middle leading-[1.4]"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10"><path d="M2 8l4 4 8-8"/></svg>
        {{ message.skillName }}
      </span>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span v-html="renderedContent"></span>
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

const props = defineProps<{ message: Message }>()
const settings = useSettingsStore()

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

// 版本号防止竞态：快速 content 变化时只接受最新版本的渲染结果
let renderVersion = 0

// 监听 content/status/theme 变化，触发完整渲染
watch(
  () => [props.message.content, props.message.status, settings.theme] as const,
  async ([content, status, theme]) => {
    if (status !== 'streaming' && content) {
      const version = ++renderVersion
      const isDark = theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      try {
        const result = await renderFull(content, isDark ? 'dark' : 'light')
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
let mermaidModule: typeof import('mermaid').default | null = null
let mermaidInitialized = false
let mermaidRenderCounter = 0

async function renderMermaidBlocks() {
  const el = document.querySelector(`[data-message-id="${props.message.id}"] .mermaid-source[data-mermaid]`)
  if (!el) return

  try {
    if (!mermaidModule) {
      mermaidModule = (await import('mermaid')).default
    }
    if (!mermaidInitialized) {
      const isDark = settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      mermaidModule.initialize({
        startOnLoad: false,
        securityLevel: 'sandbox',
        theme: isDark ? 'dark' : 'default',
      })
      mermaidInitialized = true
    }
    const sources = document.querySelectorAll(`[data-message-id="${props.message.id}"] .mermaid-source[data-mermaid]`)
    for (const source of sources) {
      const content = source.textContent ?? ''
      // 用递增计数器保证 ID 全局唯一，避免同一 tick 内 Date.now() 重复
      const mermaidId = `mermaid-${mermaidRenderCounter++}`
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
function handleBodyClick(e: MouseEvent) {
  const target = e.target as HTMLElement

  // 复制按钮
  if (target.matches('.code-copy-btn')) {
    e.preventDefault()
    const codeBlock = target.closest('.code-block')
    const codeEl = codeBlock?.querySelector('pre code') ?? codeBlock?.querySelector('code')
    const code = codeEl?.textContent ?? ''
    navigator.clipboard.writeText(code)
    target.textContent = '已复制'
    setTimeout(() => { target.textContent = '复制' }, 1500)
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
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

const batchInfoMap = computed(() => {
  const result = new Map<string, BatchInfo>()
  const toolCalls = props.message.toolCalls
  if (!toolCalls || toolCalls.length < 2) return result

  let batchStart = 0
  for (let i = 1; i <= toolCalls.length; i++) {
    const isEnd = i === toolCalls.length || toolCalls[i].toolName !== toolCalls[batchStart].toolName
    if (isEnd) {
      const size = i - batchStart
      // Only group file operation batches (write, edit)
      const name = toolCalls[batchStart].toolName
      if (size >= 2 && (name === 'write' || name === 'edit')) {
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

<!-- msg__body 内的元素由 v-html 渲染，无法用 Tailwind 类作用于动态内容 -->
<style>
/* ── 标题 ── */
.msg__body h1 { font-size: 1.5em; font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin: 24px 0 16px; }
.msg__body h2 { font-size: 1.25em; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin: 24px 0 16px; }
.msg__body h3 { font-size: 1.1em; font-weight: 600; margin: 24px 0 16px; }
.msg__body h4 { font-size: 1em; font-weight: 600; margin: 24px 0 16px; }
.msg__body h1:first-child, .msg__body h2:first-child, .msg__body h3:first-child { margin-top: 0; }

/* ── 段落 ── */
.msg__body p { margin-bottom: 16px; }
.msg__body p:last-child { margin-bottom: 0; }

/* ── 列表 ── */
.msg__body ul, .msg__body ol { padding-left: 2em; margin-bottom: 16px; }
.msg__body li { margin-bottom: 4px; }
.msg__body li + li { margin-top: 4px; }
.msg__body ul ul, .msg__body ol ol, .msg__body ul ol, .msg__body ol ul { margin-bottom: 4px; margin-top: 4px; }

/* ── 引用块 ── */
.msg__body blockquote {
  padding: 0 1em;
  margin: 0 0 16px;
  border-left: 0.25em solid var(--border);
  color: var(--muted);
}

/* ── 行内代码 ── */
.msg__body code {
  background: var(--section-bg);
  padding: 0.2em 0.4em;
  border-radius: var(--radius-xs);
  font-size: 12px;
  font-family: var(--font-mono);
}

/* ── 表格 ── */
.msg__body .table-wrapper {
  width: 100%;
  margin-bottom: 16px;
  overflow-x: auto;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.msg__body table {
  border-collapse: collapse;
  width: 100%;
}
.msg__body th, .msg__body td {
  border: 1px solid var(--border);
  padding: 6px 13px;
}
.msg__body th {
  font-weight: 600;
  background: var(--section-bg);
  border-bottom: 2px solid var(--border);
}
.msg__body tr:nth-child(2n) { background: var(--section-bg); }
.msg__body table tr:first-child th:first-child { border-top-left-radius: var(--radius-sm); }
.msg__body table tr:first-child th:last-child { border-top-right-radius: var(--radius-sm); }
.msg__body table tr:last-child td:first-child { border-bottom-left-radius: var(--radius-sm); }
.msg__body table tr:last-child td:last-child { border-bottom-right-radius: var(--radius-sm); }

/* ── 链接 ── */
.msg__body a { color: var(--accent); text-decoration: none; }
.msg__body a:hover { text-decoration: underline; }

/* ── 分隔线 ── */
.msg__body hr { border: none; border-top: 2px solid var(--border); margin: 24px 0; }

/* ── 删除线 ── */
.msg__body del { color: var(--muted); }

/* ── 任务列表 ── */
.msg__body .task-list-item { list-style: none; margin-left: -1.5em; }
.msg__body .task-list-item input[type="checkbox"] { margin-right: 6px; }

/* ── 代码块 ── */
.msg__body .code-block {
  margin-bottom: 16px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--section-bg);
}
.msg__body .code-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--muted);
  font-family: var(--font-mono);
  border-bottom: 1px solid var(--border);
}
.msg__body .code-block-lang { font-weight: 500; }
.msg__body .code-block-filename { opacity: 0.7; }
.msg__body .code-block-body {
  display: flex;
  overflow-x: auto;
}
.msg__body .line-numbers {
  flex-shrink: 0;
  padding: 12px 8px 12px 12px;
  text-align: right;
  user-select: none;
  color: var(--muted);
  opacity: 0.6;
  border-right: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
}
.msg__body .code-block pre {
  margin: 0 !important;
  padding: 12px 16px;
  background: transparent !important;
  flex: 1;
  overflow-x: auto;
  /* 覆盖 Shiki 内联样式 */
  background-color: transparent !important;
}
.msg__body .code-block pre code {
  background: none !important;
  padding: 0 !important;
  border-radius: 0 !important;
  font-size: 12px;
  line-height: 1.5;
  font-family: var(--font-mono);
  white-space: pre;
}
.msg__body .code-copy-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  color: var(--muted);
  transition: opacity 0.2s;
}
.msg__body .code-copy-btn:hover { opacity: 0.8; }
.msg__body .code-expand-btn {
  width: 100%;
  padding: 6px;
  background: var(--section-bg);
  border: none;
  border-top: 1px solid var(--border);
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  transition: opacity 0.2s;
}
.msg__body .code-expand-btn:hover { opacity: 0.8; }

/* 折叠状态：限制 body 高度为约 12 行 */
.msg__body .code-block[data-collapsed="true"] .code-block-body {
  max-height: calc(12px * 1.5 * 12 + 24px);
  overflow: hidden;
  position: relative;
}
.msg__body .code-block[data-collapsed="true"] .code-block-body::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  background: linear-gradient(transparent, var(--bg));
  pointer-events: none;
}
.msg__body .code-block[data-collapsed="false"] .code-block-body {
  max-height: none;
  overflow: visible;
}

/* ── Mermaid ── */
.msg__body .mermaid-source {
  margin: 16px 0;
  padding: 16px;
  background: var(--section-bg);
  border-radius: var(--radius-sm);
  text-align: center;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre;
  overflow-x: auto;
}
.msg__body .mermaid-rendered {
  margin: 16px 0;
  padding: 16px;
  text-align: center;
  overflow-x: auto;
}
.msg__body .mermaid-rendered svg { max-width: 100%; }
.msg__body .mermaid-error-msg {
  color: var(--danger);
  font-size: 12px;
  margin-bottom: 8px;
}

/* ── 用户消息气泡内的代码覆盖 ── */
[data-role="user"] .msg__body code {
  background: rgba(255, 255, 255, 0.2);
  color: white;
}
</style>
