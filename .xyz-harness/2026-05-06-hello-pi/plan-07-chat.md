# Plan 07 — Chat Features

Build the complete chat experience. Assumes Task 6 (App Shell) is done: `src/components/ui/` shadcn-vue primitives exist, Tailwind design tokens are registered, `src/types/index.ts` has all types, and `src/composables/useChat.ts` works.

## Dependencies to install

```bash
npm install @tanstack/vue-virtual dompurify
npm install -D @types/dompurify
```

> `markdown-it` and `@types/markdown-it` already exist in `package.json`.

---

## Batch 1 — Markdown utility + MessageBubble + StreamingText

> Commit: `feat(chat): add markdown renderer, MessageBubble, StreamingText`

### Step 1.1 — `src/lib/markdown.ts`

Singleton markdown-it with safe defaults, wrapped with DOMPurify.

- [ ] Create file

```typescript
// src/lib/markdown.ts
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

/**
 * Render markdown to sanitized HTML.
 * Singleton instance — configured once, reused everywhere.
 */
export function renderMarkdown(raw: string): string {
  const html = md.render(raw)
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'code', 'pre',
      'a', 'ul', 'ol', 'li', 'blockquote',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'span', 'del',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  })
}
```

### Step 1.2 — `src/components/chat/MessageBubble.vue`

Replaces the existing flat `src/components/MessageBubble.vue`. Renders user / assistant / system messages. Delegates tool calls to `ToolCallCard`, thinking to `ThinkingBlock`, streaming text to `StreamingText`.

- [ ] Create file

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/lib/markdown'
import type { ChatMessage, AssistantSegment, TaskNode } from '@/types'
import ToolCallCard from './ToolCallCard.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import StreamingText from './StreamingText.vue'

const props = defineProps<{
  message: ChatMessage
  isStreaming?: boolean
  taskNodes: Map<string, TaskNode>
  toolUseToTaskId: Map<string, string>
  selectMode?: boolean
  selected?: boolean
  onOpenSubAgentTab?: (taskId: string) => void
}>()

const emit = defineEmits<{
  'toggle-select': [id: string]
}>()

function handleClick() {
  if (props.selectMode) {
    emit('toggle-select', props.message.id)
  }
}

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')
const segments = computed<AssistantSegment[]>(() => props.message.segments ?? [])
</script>

<template>
  <!-- eslint-disable vue/no-v-html -->
  <!-- Selection wrapper -->
  <div
    class="relative"
    :class="[
      selectMode ? 'cursor-pointer' : '',
      selectMode && selected ? 'rounded-md ring-1 ring-semantic-green/40' : '',
    ]"
    @click="handleClick"
  >
    <!-- Select checkbox -->
    <div v-if="selectMode" class="absolute -left-1.5 top-1/2 z-10 -translate-y-1/2">
      <div
        class="flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px] font-bold leading-none"
        :class="selected
          ? 'border-semantic-green bg-semantic-green text-white'
          : 'border-border-default bg-elevated'"
      >
        <span v-if="selected">&#10003;</span>
      </div>
    </div>

    <div :class="selectMode ? 'ml-3' : ''">

      <!-- ── User message ─────────────────────────── -->
      <div v-if="isUser" class="flex items-start gap-2 border-l-[3px] border-l-muted-foreground/50 bg-user px-2 py-1.5">
        <div class="flex w-20 shrink-0 items-center gap-1.5">
          <div class="flex h-4 w-4 items-center justify-center rounded bg-inset text-[10px] font-mono font-bold text-muted-foreground">U</div>
          <span class="font-mono text-[10px] text-tertiary">User</span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="prose max-w-none text-foreground" v-html="renderMarkdown(message.content)" />
        </div>
      </div>

      <!-- ── System message ───────────────────────── -->
      <div v-else-if="isSystem" class="rounded-md border border-semantic-red/30 bg-semantic-red/10 px-3 py-1.5">
        <div class="flex items-center gap-2 text-[10px] font-medium text-semantic-red">
          <span>!</span>
          <span>System</span>
        </div>
        <div class="mt-1 text-[10px] text-semantic-red" v-html="renderMarkdown(message.content)" />
      </div>

      <!-- ── Assistant message ────────────────────── -->
      <div v-else class="flex items-start gap-2 border-l-[3px] border-l-semantic-green bg-ai px-2 py-1.5">
        <div class="flex w-20 shrink-0 items-center gap-1.5">
          <div class="flex h-4 w-4 items-center justify-center rounded bg-semantic-green/10 text-[10px] font-mono font-bold text-semantic-green">&lambda;</div>
          <span class="font-mono text-[10px] text-semantic-green">Assistant</span>
        </div>

        <div class="min-w-0 flex-1">
          <template v-if="segments.length > 0">
            <template v-for="(seg, idx) in segments" :key="idx">
              <!-- text segment -->
              <StreamingText
                v-if="seg.type === 'text'"
                :text="seg.text"
                :is-last="idx === segments.length - 1"
                :is-streaming="isStreaming && idx === segments.length - 1"
                :class="{ 'mb-2': idx < segments.length - 1 }"
              />

              <!-- tool segment -->
              <div v-else-if="seg.type === 'tool'" class="mb-2">
                <ToolCallCard
                  :tool-call="seg.call"
                  :task-nodes="taskNodes"
                  :tool-use-to-task-id="toolUseToTaskId"
                  :task-id="toolUseToTaskId.get(seg.call.tool_use_id)"
                  :on-open-tab="onOpenSubAgentTab"
                />
              </div>

              <!-- thinking segment -->
              <ThinkingBlock
                v-else-if="seg.type === 'thinking'"
                :text="seg.text"
                :duration-ms="seg.duration_ms"
                class="mb-2"
              />
            </template>
          </template>

          <!-- Fallback: no segments, use raw content -->
          <div v-else-if="message.content" class="prose max-w-none text-foreground" v-html="renderMarkdown(message.content)" />
        </div>
      </div>

    </div>
  </div>
</template>
```

### Step 1.3 — `src/components/chat/StreamingText.vue`

Displays text that may still be streaming. Renders via `renderMarkdown` once stable; shows blinking cursor at end during generation.

- [ ] Create file

```vue
<script setup lang="ts">
import { renderMarkdown } from '@/lib/markdown'

defineProps<{
  text: string
  isLast: boolean
  isStreaming: boolean
}>()
</script>

<template>
  <!-- eslint-disable vue/no-v-html -->
  <div>
    <div class="prose max-w-none text-foreground" v-html="renderMarkdown(text)" />
    <!-- Blinking cursor while streaming on the last text segment -->
    <span
      v-if="isStreaming && isLast"
      class="ml-0.5 inline-block h-3 w-1.5 animate-cursor-blink bg-semantic-green"
    />
  </div>
</template>
```

---

## Batch 2 — ToolCallCard + ThinkingBlock

> Commit: `feat(chat): add ToolCallCard and ThinkingBlock components`

### Step 2.1 — `src/components/chat/ToolCallCard.vue`

Replaces flat `src/components/ToolCallCard.vue`. Collapsible card with collapsed/expanded states.

- [ ] Create file

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ToolCallDisplay, TaskNode } from '@/types'
import { getToolDangerLevel } from '@/types'
import { ChevronDown } from 'lucide-vue-next'

const props = defineProps<{
  toolCall: ToolCallDisplay
  taskNodes: Map<string, TaskNode>
  toolUseToTaskId: Map<string, string>
  taskId?: string
  onOpenTab?: (taskId: string) => void
}>()

const expanded = ref(false)

function toggle() {
  expanded.value = !expanded.value
}

const dangerLevel = computed(() => getToolDangerLevel(props.toolCall.tool_name))

const activeColor = computed(() =>
  props.toolCall.status === 'error' ? 'error' : dangerLevel.value,
)

const colorMap = {
  safe:    { border: 'border-l-semantic-green',  text: 'text-semantic-green',  bg: 'bg-semantic-green/5',  spin: 'border-semantic-green' },
  caution: { border: 'border-l-semantic-yellow', text: 'text-semantic-yellow', bg: 'bg-semantic-yellow/5', spin: 'border-semantic-yellow' },
  error:   { border: 'border-l-semantic-red',    text: 'text-semantic-red',    bg: 'bg-semantic-red/5',    spin: 'border-semantic-red' },
}

const colors = computed(() => colorMap[activeColor.value])

const statusLabel = computed(() => {
  switch (props.toolCall.status) {
    case 'running': return 'running...'
    case 'error': return 'failed'
    case 'completed': return 'done'
    default: return 'unknown'
  }
})

/** Extract a short file-path hint from tool input for the collapsed header. */
const filePathHint = computed(() => {
  const input = props.toolCall.input
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  return String(obj.path ?? obj.file_path ?? obj.command ?? '')
})

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '...'
}

const inputSummary = computed(() => {
  const input = props.toolCall.input
  if (!input || typeof input !== 'object') return ''
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 3)
  return entries.map(([k, v]) => `${k}: ${truncate(String(v), 80)}`).join('\n')
})
</script>

<template>
  <div
    class="overflow-hidden rounded-md border border-border-default border-l-[3px] bg-elevated text-[13px]"
    :class="colors.border"
  >
    <!-- Header — always visible, click to toggle -->
    <button
      class="flex w-full items-center justify-between px-2.5 py-1 text-left"
      :class="[colors.bg, 'hover:brightness-110']"
      @click="toggle"
    >
      <div class="flex items-center gap-2">
        <!-- Spinner / check / cross -->
        <span
          v-if="toolCall.status === 'running'"
          class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent"
          :class="colors.spin"
        />
        <span v-else class="font-mono text-[10px] font-bold" :class="colors.text">
          {{ toolCall.status === 'error' ? '\u2717' : '\u2713' }}
        </span>
        <span class="font-mono font-semibold text-foreground">{{ toolCall.tool_name }}</span>
        <span v-if="filePathHint" class="truncate font-mono text-[10px] text-muted-foreground">
          {{ truncate(filePathHint, 50) }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span class="font-mono text-[10px]" :class="colors.text">{{ statusLabel }}</span>
        <ChevronDown
          class="h-3 w-3 text-muted-foreground transition-transform"
          :class="expanded ? 'rotate-180' : ''"
        />
      </div>
    </button>

    <!-- Expanded body -->
    <div v-if="expanded" class="border-t border-border-default">
      <!-- Input -->
      <pre
        v-if="inputSummary"
        class="whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] text-muted-foreground"
      >{{ inputSummary }}</pre>

      <!-- Output -->
      <div
        v-if="toolCall.output !== undefined && toolCall.status !== 'running'"
        class="mx-2.5 mb-2 max-h-52 overflow-y-auto rounded-md border border-border-default bg-inset p-2"
      >
        <pre class="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{{ toolCall.output }}</pre>
      </div>
    </div>
  </div>
</template>
```

### Step 2.2 — `src/components/chat/ThinkingBlock.vue`

Default-collapsed thinking block. Shows "Thinking..." with duration, click to expand.

- [ ] Create file

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

defineProps<{
  text: string
  durationMs: number
}>()

const expanded = ref(false)

function toggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="overflow-hidden rounded-md border border-border-default bg-ai">
    <!-- Header -->
    <button
      class="flex w-full items-center gap-1.5 bg-ai px-3 py-1.5 text-left hover:brightness-110"
      @click="toggle"
    >
      <span class="text-[8px] text-semantic-blue">&#9670;</span>
      <span class="font-mono text-[11px] text-semantic-blue">Thinking</span>
      <span v-if="durationMs > 0" class="font-mono text-[10px] text-tertiary">
        {{ (durationMs / 1000).toFixed(1) }}s
      </span>
      <ChevronDown
        class="ml-auto h-3 w-3 text-muted-foreground transition-transform"
        :class="expanded ? 'rotate-180' : ''"
      />
    </button>

    <!-- Body -->
    <div v-if="expanded" class="border-t border-border-default px-3 py-2">
      <pre class="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">{{ text }}</pre>
    </div>
  </div>
</template>
```

---

## Batch 3 — MessageList + ContextBar

> Commit: `feat(chat): add virtual-scroll MessageList and ContextBar`

### Step 3.1 — `src/components/chat/MessageList.vue`

Virtual-scrolled message list using `@tanstack/vue-virtual`. Auto-scrolls to bottom on new messages. Renders `MessageBubble` per message.

- [ ] Create file

```vue
<script setup lang="ts">
import { ref, watch, nextTick, type Ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { ChatMessage, TaskNode } from '@/types'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{
  messages: ChatMessage[]
  isStreaming: boolean
  taskNodes: Map<string, TaskNode>
  toolUseToTaskId: Map<string, string>
  selectMode?: boolean
  selectedIds: Set<string>
  onOpenSubAgentTab?: (taskId: string) => void
}>()

const emit = defineEmits<{
  'toggle-select': [id: string]
}>()

const scrollRef = ref<HTMLDivElement | null>(null)

const virtualizer = useVirtualizer(
  {
    get count() { return props.messages.length },
    getScrollElement: () => scrollRef.value,
    estimateSize: (index: number) => {
      const msg = props.messages[index]
      if (!msg) return 60
      // Rough estimate: text messages are taller, tool cards are medium
      if (msg.segments?.length) return 120
      if (msg.content.length > 200) return 120
      return 60
    },
    overscan: 5,
  },
  scrollRef as Ref<HTMLDivElement | null>,
)

// Track whether user is near bottom
const isNearBottom = ref(true)

function handleScroll() {
  const el = scrollRef.value
  if (!el) return
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100
}

// Auto-scroll to bottom when new messages arrive and user is near bottom
watch(
  () => props.messages.length,
  async () => {
    if (!isNearBottom.value && !props.isStreaming) return
    await nextTick()
    virtualizer.value.scrollToIndex(props.messages.length - 1, { align: 'end' })
  },
)

// Also scroll when streaming pushes segment updates
watch(
  () => props.isStreaming,
  async (streaming) => {
    if (streaming) {
      await nextTick()
      virtualizer.value.scrollToIndex(props.messages.length - 1, { align: 'end' })
    }
  },
)
</script>

<template>
  <div ref="scrollRef" class="flex-1 overflow-y-auto" @scroll="handleScroll">
    <div
      :style="{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }"
    >
      <div
        v-for="virtualItem of virtualizer.getVirtualItems()"
        :key="virtualItem.key"
        :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${virtualItem.start}px)`,
        }"
        class="px-2 py-0.5"
        :data-index="virtualItem.index"
      >
        <MessageBubble
          :message="messages[virtualItem.index]"
          :is-streaming="isStreaming && virtualItem.index === messages.length - 1"
          :task-nodes="taskNodes"
          :tool-use-to-task-id="toolUseToTaskId"
          :select-mode="selectMode"
          :selected="selectedIds.has(messages[virtualItem.index]?.id)"
          :on-open-sub-agent-tab="onOpenSubAgentTab"
          @toggle-select="(id) => emit('toggle-select', id)"
        />
      </div>
    </div>
  </div>
</template>
```

### Step 3.2 — `src/components/chat/ContextBar.vue`

Compact token-usage progress bar. Color shifts with usage level.

- [ ] Create file

```vue
<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** 0–100 percentage of context window used */
  percentage: number
}>()

const barColor = computed(() => {
  if (props.percentage > 85) return 'bg-semantic-red'
  if (props.percentage > 60) return 'bg-semantic-yellow'
  return 'bg-semantic-green'
})

const textColor = computed(() => {
  if (props.percentage > 85) return 'text-semantic-red'
  if (props.percentage > 60) return 'text-semantic-yellow'
  return 'text-tertiary'
})
</script>

<template>
  <div class="flex items-center gap-1.5">
    <div class="h-1 w-16 rounded-full bg-border-default">
      <div
        class="h-full rounded-full transition-all duration-300 ease-out"
        :class="barColor"
        :style="{ width: `${Math.min(percentage, 100)}%` }"
      />
    </div>
    <span class="font-mono text-[10px]" :class="textColor">
      {{ percentage.toFixed(0) }}%
    </span>
  </div>
</template>
```

---

## Batch 4 — ChatInput + ModelPicker + SlashMenu

> Commit: `feat(chat): add ChatInput, ModelPicker, SlashMenu`

### Step 4.1 — `src/components/chat/ChatInput.vue`

Full input area replacing `MessageInput.vue`. Textarea with auto-resize, toolbar with upload button (placeholder), ModelPicker, ContextBar, Send/Stop.

- [ ] Create file

```vue
<script setup lang="ts">
import { ref, nextTick, computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import ModelPicker from './ModelPicker.vue'
import ContextBar from './ContextBar.vue'
import SlashMenu from './SlashMenu.vue'
import { Plus, ArrowRight, Square } from 'lucide-vue-next'

const props = defineProps<{
  isStreaming: boolean
  currentModel: string
  contextPercentage: number
}>()

const emit = defineEmits<{
  send: [content: string]
  cancel: []
  'select-model': [modelRef: string]
}>()

const inputText = ref('')
const isFocused = ref(false)
const isComposing = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const MAX_TEXTAREA_HEIGHT = 140

// Slash menu state
const showSlashMenu = ref(false)
const slashMenuIndex = ref(0)

const canSend = computed(() => inputText.value.trim().length > 0)

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px'
}

function handleInput() {
  autoResize()
  // Show slash menu when typing '/' at start of input
  showSlashMenu.value = inputText.value.startsWith('/')
}

function handleKeydown(e: KeyboardEvent) {
  // Slash menu keyboard navigation
  if (showSlashMenu.value) {
    if (e.key === 'Escape') {
      showSlashMenu.value = false
      return
    }
    // SlashMenu handles up/down/enter internally via props
  }

  if (e.key === 'Enter' && !e.shiftKey && !isComposing.value) {
    e.preventDefault()
    handleSend()
  }
}

function handleSend() {
  const trimmed = inputText.value.trim()
  if (!trimmed) return
  emit('send', trimmed)
  inputText.value = ''
  showSlashMenu.value = false
  nextTick(autoResize)
}

function handleCancel() {
  emit('cancel')
}

function handleSelectModel(modelRef: string) {
  emit('select-model', modelRef)
}
</script>

<template>
  <div class="border-t border-border-default bg-base px-4 py-3">
    <!-- Slash menu popup -->
    <SlashMenu
      v-if="showSlashMenu"
      :visible="showSlashMenu"
      @close="showSlashMenu = false"
    />

    <!-- Textarea row -->
    <div
      class="flex items-center gap-3"
      :class="isFocused ? 'border-b-2 border-semantic-green pb-px' : 'border-b-2 border-transparent pb-px'"
    >
      <!-- Terminal prefix -->
      <span class="shrink-0 font-mono text-sm text-semantic-green">&gt;</span>

      <Textarea
        ref="textareaRef"
        v-model="inputText"
        :disabled="isStreaming"
        placeholder="输入消息..."
        class="min-h-[1.75rem] max-h-[140px] flex-1 resize-none bg-transparent font-mono text-sm leading-[1.75rem] text-foreground placeholder:text-tertiary focus:outline-none"
        rows="1"
        @input="handleInput"
        @keydown="handleKeydown"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @focus="isFocused = true"
        @blur="isFocused = false"
      />

      <!-- Send / Stop button -->
      <Button
        v-if="!isStreaming"
        variant="ghost"
        size="sm"
        :disabled="!canSend"
        class="shrink-0 font-mono text-xs text-tertiary hover:bg-semantic-green/15 hover:text-semantic-green disabled:opacity-30"
        @click="handleSend"
      >
        <ArrowRight class="h-3.5 w-3.5" />
        <span>Enter</span>
      </Button>
      <Button
        v-else
        variant="ghost"
        size="sm"
        class="shrink-0 font-mono text-xs text-semantic-red hover:bg-semantic-red/10 hover:text-semantic-red"
        @click="handleCancel"
      >
        <Square class="h-3.5 w-3.5" />
        <span>Stop</span>
      </Button>
    </div>

    <!-- Toolbar row -->
    <div class="mt-2 flex items-center justify-between">
      <div class="flex items-center gap-1">
        <!-- Upload placeholder -->
        <Button
          variant="ghost"
          size="sm"
          class="font-mono text-[11px] text-tertiary hover:bg-inset hover:text-foreground"
          disabled
        >
          <Plus class="h-3 w-3" />
        </Button>
      </div>

      <div class="flex items-center gap-3">
        <!-- Context usage -->
        <div class="flex items-center gap-1.5 font-mono text-[10px] text-tertiary">
          <span>ctx:</span>
          <ContextBar :percentage="contextPercentage" />
        </div>

        <!-- Model picker -->
        <ModelPicker
          :current-model="currentModel"
          @select="handleSelectModel"
        />
      </div>
    </div>
  </div>
</template>
```

### Step 4.2 — `src/components/chat/ModelPicker.vue`

Compact model selector. Shows `sonnet @ anthropic` style label, dropdown grouped by provider.

- [ ] Create file

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useModelManager } from '@/composables/useModelManager'
import { Button } from '@/components/ui/button'
import { ChevronDown } from 'lucide-vue-next'
import type { ModelInfo, ModelTier } from '@/types'

const props = defineProps<{
  currentModel: string
}>()

const emit = defineEmits<{
  select: [modelRef: string]
}>()

const { models, load } = useModelManager()
const open = ref(false)

const tierLabel: Record<ModelTier, string> = {
  balanced: 'balanced',
  reasoning: 'reasoning',
  fast: 'fast',
}

const tierColor: Record<ModelTier, string> = {
  balanced: 'text-semantic-green',
  reasoning: 'text-semantic-yellow',
  fast: 'text-semantic-blue',
}

// Group by provider
const groupedByProvider = computed(() => {
  const map = new Map<string, ModelInfo[]>()
  for (const m of models.value) {
    const list = map.get(m.provider_name) ?? []
    list.push(m)
    map.set(m.provider_name, list)
  }
  return map
})

// Current model display info
const currentInfo = computed(() => {
  const m = models.value.find((m) => m.model_ref === props.currentModel)
  if (!m) return { shortName: props.currentModel, provider: '' }
  return {
    shortName: m.alias ?? m.model_id,
    provider: m.provider_name,
  }
})

// Label: "sonnet @ anthropic"
const displayLabel = computed(() => {
  const info = currentInfo.value
  if (info.provider) return `${info.shortName} @ ${info.provider}`
  return info.shortName
})

function toggle() {
  open.value = !open.value
  if (open.value && models.value.length === 0) {
    load()
  }
}

function select(modelRef: string) {
  emit('select', modelRef)
  open.value = false
}

function handleClickOutside(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('.model-picker-root')) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  load()
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="model-picker-root relative">
    <Button
      variant="ghost"
      class="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[11px] transition-colors hover:bg-inset"
      :class="open ? 'bg-inset text-foreground' : 'text-tertiary'"
      @click="toggle"
    >
      <span>{{ displayLabel }}</span>
      <ChevronDown
        class="h-3 w-3 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </Button>

    <!-- Dropdown -->
    <div
      v-if="open"
      class="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border-default bg-elevated py-1 shadow-lg"
    >
      <template v-for="[provider, providerModels] of groupedByProvider" :key="provider">
        <div class="px-3 pt-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-tertiary">
          {{ provider }}
        </div>
        <Button
          v-for="m in providerModels"
          :key="m.model_ref"
          variant="ghost"
          size="sm"
          class="w-full justify-between px-3 py-1 font-mono text-[11px] hover:bg-inset"
          :class="m.model_ref === currentModel ? 'text-semantic-green' : 'text-foreground'"
          @click="select(m.model_ref)"
        >
          <span class="truncate">{{ m.alias ?? m.model_id }}</span>
          <span :class="tierColor[m.tier]" class="ml-2 shrink-0 text-[10px]">
            {{ tierLabel[m.tier] }}
          </span>
        </Button>
      </template>
    </div>
  </div>
</template>
```

### Step 4.3 — `src/components/chat/SlashMenu.vue`

P1: Empty menu with "No commands available" message. Appears above input when typing `/`. Keyboard navigation support.

- [ ] Create file

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

// P1: no commands — placeholder array for future extensibility
const commands: Array<{ name: string; description: string }> = []
const selectedIndex = ref(0)

function handleKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      selectedIndex.value = Math.max(0, selectedIndex.value - 1)
      break
    case 'ArrowDown':
      e.preventDefault()
      selectedIndex.value = Math.min(commands.length - 1, selectedIndex.value + 1)
      break
    case 'Enter':
      e.preventDefault()
      if (commands.length > 0 && commands[selectedIndex.value]) {
        // Future: execute command
      }
      break
    case 'Escape':
      e.preventDefault()
      emit('close')
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

const props = defineProps<{
  visible: boolean
}>()
</script>

<template>
  <div
    v-if="visible"
    class="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-md border border-border-default bg-elevated px-3 py-4 shadow-lg"
  >
    <div v-if="commands.length === 0" class="text-center font-mono text-[11px] text-tertiary">
      No commands available
    </div>
    <!-- Future: command list with keyboard highlight -->
    <div v-else class="space-y-0.5">
      <div
        v-for="(cmd, i) in commands"
        :key="cmd.name"
        class="flex items-center gap-2 rounded-sm px-2 py-1"
        :class="i === selectedIndex ? 'bg-inset text-foreground' : 'text-muted-foreground'"
      >
        <span class="font-mono text-[11px]">/{{ cmd.name }}</span>
        <span class="text-[10px] text-tertiary">{{ cmd.description }}</span>
      </div>
    </div>
  </div>
</template>
```

> **Note:** `SlashMenu.vue` has a duplicate `defineProps` — fix by removing the second one. The correct version:

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

// P1: no commands — placeholder for future extensibility
const commands: Array<{ name: string; description: string }> = []
const selectedIndex = ref(0)

function handleKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      selectedIndex.value = Math.max(0, selectedIndex.value - 1)
      break
    case 'ArrowDown':
      e.preventDefault()
      selectedIndex.value = Math.min(commands.length - 1, selectedIndex.value + 1)
      break
    case 'Enter':
      e.preventDefault()
      // Future: execute commands[selectedIndex.value]
      break
    case 'Escape':
      e.preventDefault()
      emit('close')
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    v-if="visible"
    class="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-md border border-border-default bg-elevated px-3 py-4 shadow-lg"
  >
    <div v-if="commands.length === 0" class="text-center font-mono text-[11px] text-tertiary">
      No commands available
    </div>
    <div v-else class="space-y-0.5">
      <div
        v-for="(cmd, i) in commands"
        :key="cmd.name"
        class="flex items-center gap-2 rounded-sm px-2 py-1"
        :class="i === selectedIndex ? 'bg-inset text-foreground' : 'text-muted-foreground'"
      >
        <span class="font-mono text-[11px]">/{{ cmd.name }}</span>
        <span class="text-[10px] text-tertiary">{{ cmd.description }}</span>
      </div>
    </div>
  </div>
</template>
```

---

## Batch 5 — Integration into ChatView

> Commit: `refactor(chat): integrate new chat/ components into ChatView`

### Step 5.1 — Update `src/components/ChatView.vue`

Replace old imports with new `chat/` components. Wire `ChatInput` toolbar events (model select, context bar). Replace native scroll with `MessageList`.

- [ ] Update imports: remove `MessageBubble`, `MessageInput`, `ToolCallCard` (old), add `MessageList`, `ChatInput` from `./chat/`
- [ ] Wire `contextPercentage` computed (already exists as `contextPercentage` in StatusBar section)
- [ ] Wire `@select-model` on `ChatInput` → call `setCurrentModel` from `useModelManager`
- [ ] Wire `@send`, `@cancel` on `ChatInput`
- [ ] Replace `<div ref="scrollContainer" class="flex-1 overflow-y-auto">` block with `<MessageList>`
- [ ] Remove old `<MessageInput>` and `<StatusBar>` → `ChatInput` now owns the toolbar; keep `StatusBar` separately if desired, or merge its info into `ChatInput` toolbar

### Step 5.2 — Verify build

- [ ] `npm run build` passes (vue-tsc + vite)
- [ ] `npm run dev` renders chat correctly
- [ ] No hardcoded colors (`eslint` taste rules pass)
- [ ] No native form elements (`eslint` taste rules pass)

---

## File tree summary

```
src/
  lib/
    markdown.ts                          ← NEW (Batch 1)
  components/
    chat/
      MessageList.vue                    ← NEW (Batch 3)
      MessageBubble.vue                  ← NEW (Batch 1)
      StreamingText.vue                  ← NEW (Batch 1)
      ToolCallCard.vue                   ← NEW (Batch 2)
      ThinkingBlock.vue                  ← NEW (Batch 2)
      ChatInput.vue                      ← NEW (Batch 4)
      ModelPicker.vue                    ← NEW (Batch 4)
      ContextBar.vue                     ← NEW (Batch 3)
      SlashMenu.vue                      ← NEW (Batch 4)
    ChatView.vue                         ← MODIFIED (Batch 5)
```

## Checklist (all steps)

- [ ] Install `@tanstack/vue-virtual`, `dompurify`, `@types/dompurify`
- [ ] Create `src/lib/markdown.ts`
- [ ] Create `src/components/chat/MessageBubble.vue`
- [ ] Create `src/components/chat/StreamingText.vue`
- [ ] Create `src/components/chat/ToolCallCard.vue`
- [ ] Create `src/components/chat/ThinkingBlock.vue`
- [ ] Create `src/components/chat/MessageList.vue`
- [ ] Create `src/components/chat/ContextBar.vue`
- [ ] Create `src/components/chat/ChatInput.vue`
- [ ] Create `src/components/chat/ModelPicker.vue`
- [ ] Create `src/components/chat/SlashMenu.vue`
- [ ] Update `src/components/ChatView.vue` to use new components
- [ ] `npm run build` passes
- [ ] `npm run dev` renders correctly
- [ ] ESLint taste rules pass
