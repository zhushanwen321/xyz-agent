# Plan 07: Chat Features v3

> **Task 6 (Chat)**: Complete chat experience — streaming messages, tool renderers, approval UI, input area, model picker
> **Prerequisite**: Task 5 (state layer) + Task 6 (app shell) complete. `chatStore` uses stable list pattern. Foundation from plan-02 installed (markdown, toast, rAF batch, tool renderer registry, slash commands).
> **Based on**: plan-07-chat.md + arch-optimization-v2.md §2.2/2.4/2.6
> **Supersedes**: plan-07-chat.md

---

## Key Changes from v2

1. **MessageList.vue** receives `completedMessages` (static, no reactivity churn)
2. **StreamingMessage.vue** — NEW component for live streaming with rAF batching
3. **MessageBubble.vue** uses `markdown.ts` utility (from plan-02)
4. **ToolCallCard.vue** dispatches to tool renderer registry instead of monolithic rendering
5. **ToolRenderers/** directory — BashToolRenderer, EditToolRenderer, ReadToolRenderer, DefaultToolRenderer
6. **ApprovalCard.vue** — NEW inline approval UI for tools requiring ask
7. **SlashMenu.vue** populated via slash command registry (not empty)
8. **ChatInput.vue** integrates ModelPicker, ContextBar (with compaction trigger)

---

## File Structure

```
src/components/chat/
├── ChatView.vue              # Updated: wires MessageList + StreamingMessage + ChatInput
├── MessageList.vue            # Virtual-scroll static completed messages
├── StreamingMessage.vue       # NEW: live streaming with rAF batching
├── MessageBubble.vue          # User/assistant/system message rendering
├── ToolCallCard.vue           # Dispatches to tool renderer registry
├── ThinkingBlock.vue          # Collapsible thinking block
├── ChatInput.vue              # Textarea + toolbar (ModelPicker + ContextBar + Send/Stop)
├── ModelPicker.vue            # Grouped model dropdown
├── ContextBar.vue             # Token usage progress bar
├── SlashMenu.vue              # Populated from slash command registry
├── ApprovalCard.vue           # NEW: inline tool approval UI
└── ToolRenderers/
    ├── DefaultToolRenderer.vue
    ├── BashToolRenderer.vue
    ├── EditToolRenderer.vue
    └── ReadToolRenderer.vue
```

---

## Batch 1 — MessageBubble + StreamingMessage + ThinkingBlock

> Commit: `feat(chat): MessageBubble, StreamingMessage, ThinkingBlock with markdown + rAF batching`

### Step 1.1: `src/components/chat/MessageBubble.vue`

- [ ] Create message bubble using `renderMarkdown` from plan-02

```vue
<!-- src/components/chat/MessageBubble.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../../lib/markdown'
import type { Message, ToolCall } from '@xyz-agent/shared'
import ToolCallCard from './ToolCallCard.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import { cn } from '../../design-system/utils'

const props = defineProps<{
  message: Message
}>()

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')

const thinkingText = computed(() => {
  if (!props.message.thinking || props.message.thinking.length === 0) return ''
  return props.message.thinking.map((t) => t.text).join('\n')
})

const hasToolCalls = computed(() =>
  props.message.toolCalls && props.message.toolCalls.length > 0,
)
</script>

<template>
  <div :class="cn(
    'p-3 rounded-lg text-sm',
    isUser ? 'bg-accent-light text-text-primary ml-12' :
    isSystem ? 'bg-surface border border-danger text-text-primary' :
    'bg-surface text-text-primary mr-12',
  )">
    <!-- Role label -->
    <div class="flex items-center gap-1.5 mb-1">
      <span class="text-xs font-mono text-text-muted">
        {{ isUser ? 'User' : isSystem ? 'System' : 'Assistant' }}
      </span>
    </div>

    <!-- Thinking block -->
    <ThinkingBlock
      v-if="thinkingText"
      :text="thinkingText"
    />

    <!-- Content (markdown rendered) -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="message.content" class="prose max-w-none" v-html="renderMarkdown(message.content)" />

    <!-- Tool calls -->
    <div v-if="hasToolCalls" class="mt-2 space-y-2">
      <ToolCallCard
        v-for="tc in message.toolCalls"
        :key="tc.id"
        :tool-call="tc"
      />
    </div>
  </div>
</template>
```

### Step 1.2: `src/components/chat/StreamingMessage.vue`

> **NEW**: Renders the live streaming message. Uses rAF batching from plan-02. Only this component is reactive during generation.

- [ ] Create streaming message component

```vue
<!-- src/components/chat/StreamingMessage.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../../lib/markdown'
import type { StreamingAssistantMessage } from '../../stores/chat'
import ToolCallCard from './ToolCallCard.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import { cn } from '../../design-system/utils'

const props = defineProps<{
  message: StreamingAssistantMessage
}>()

const hasText = computed(() => props.message.textContent.length > 0)
const hasThinking = computed(() => props.message.thinkingContent.length > 0)
const hasToolCalls = computed(() => props.message.toolCalls.length > 0)
</script>

<template>
  <div class="p-3 rounded-lg bg-surface text-text-primary mr-12">
    <div class="flex items-center gap-1.5 mb-1">
      <span class="text-xs font-mono text-text-muted">Assistant</span>
      <span class="inline-block w-1.5 h-3 bg-accent animate-pulse" />
    </div>

    <!-- Thinking (live) -->
    <ThinkingBlock
      v-if="hasThinking"
      :text="message.thinkingContent"
      :streaming="true"
    />

    <!-- Text content (live) -->
    <div v-if="hasText" class="prose max-w-none">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-html="renderMarkdown(message.textContent)" />
      <span class="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5" />
    </div>

    <!-- Tool calls (live) -->
    <div v-if="hasToolCalls" class="mt-2 space-y-2">
      <ToolCallCard
        v-for="tc in message.toolCalls"
        :key="tc.id"
        :tool-call="tc"
      />
    </div>
  </div>
</template>
```

### Step 1.3: `src/components/chat/ThinkingBlock.vue`

- [ ] Create collapsible thinking block

```vue
<!-- src/components/chat/ThinkingBlock.vue -->
<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  text: string
  streaming?: boolean
}>()

const expanded = ref(false)
</script>

<template>
  <div class="overflow-hidden rounded-md border border-border bg-surface mb-2">
    <button
      class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-surface transition-colors"
      @click="expanded = !expanded"
    >
      <span class="text-xs text-text-muted">&#9670;</span>
      <span class="text-xs font-mono text-text-muted">Thinking</span>
      <span v-if="streaming" class="inline-block w-1.5 h-2.5 bg-accent animate-pulse" />
      <svg
        xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="ml-auto text-text-muted transition-transform"
        :class="expanded ? 'rotate-180' : ''"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
    <div v-if="expanded" class="border-t border-border px-3 py-2">
      <pre class="whitespace-pre-wrap font-mono text-xs leading-relaxed text-text-muted">{{ text }}</pre>
    </div>
  </div>
</template>
```

### Step 1.4: Commit

- [ ] `git add -A && git commit -m "feat(chat): MessageBubble, StreamingMessage, ThinkingBlock — markdown + rAF streaming"`

---

## Batch 2 — Tool Renderer Registry + ToolCallCard + ToolRenderers

> Commit: `feat(chat): tool renderer registry integration, ToolCallCard dispatch, 4 tool renderers`

### Step 2.1: Register tool renderers

- [ ] Create `src/lib/register-tool-renderers.ts`

```ts
// src/lib/register-tool-renderers.ts
import { registerToolRenderer } from './tool-renderer-registry'

/**
 * Register all P1 tool renderers.
 * Called once during app initialization.
 */
export function registerBuiltinToolRenderers(): void {
  registerToolRenderer('bash', () =>
    import('../components/chat/ToolRenderers/BashToolRenderer.vue')
      .then((m) => m.default as any),
  )
  registerToolRenderer('edit', () =>
    import('../components/chat/ToolRenderers/EditToolRenderer.vue')
      .then((m) => m.default as any),
  )
  registerToolRenderer('read', () =>
    import('../components/chat/ToolRenderers/ReadToolRenderer.vue')
      .then((m) => m.default as any),
  )
  registerToolRenderer('write', () =>
    import('../components/chat/ToolRenderers/DefaultToolRenderer.vue')
      .then((m) => m.default as any),
  )
}
```

- [ ] Add to `src/main.ts`

```ts
// Add after registerBuiltinSlashCommands():
import { registerBuiltinToolRenderers } from './lib/register-tool-renderers'
registerBuiltinToolRenderers()
```

### Step 2.2: `src/components/chat/ToolCallCard.vue`

> **Key v3 change**: Dispatches to tool renderer registry. Falls back to DefaultToolRenderer.

- [ ] Create ToolCallCard with registry dispatch

```vue
<!-- src/components/chat/ToolCallCard.vue -->
<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onMounted, type Component } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'
import { getToolRenderer, hasToolRenderer } from '../../lib/tool-renderer-registry'
import { cn } from '../../design-system/utils'

const props = defineProps<{
  toolCall: ToolCall
}>()

const expanded = ref(false)
const rendererComponent = ref<Component | null>(null)

// Load the tool-specific renderer
onMounted(async () => {
  if (hasToolRenderer(props.toolCall.toolName)) {
    rendererComponent.value = (await getToolRenderer(props.toolCall.toolName)) ?? null
  }
})

// Default renderer as fallback
const DefaultRenderer = defineAsyncComponent(() =>
  import('./ToolRenderers/DefaultToolRenderer.vue'),
)

const isRunning = computed(() => props.toolCall.status === 'running')
const isCompleted = computed(() => props.toolCall.status === 'completed')
const isError = computed(() => props.toolCall.status === 'error')

const statusIcon = computed(() => {
  if (isRunning.value) return 'running'
  if (isError.value) return 'error'
  return 'done'
})

/** Extract short file path hint from tool input. */
const filePathHint = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input
    return String(obj.path ?? obj.file_path ?? obj.command ?? '')
  } catch {
    return String(input).slice(0, 50)
  }
})

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '...'
}
</script>

<template>
  <div
    class="overflow-hidden rounded-md border border-border border-l-[3px] bg-surface text-sm"
    :class="cn(
      isRunning && 'border-l-warning',
      isCompleted && 'border-l-success',
      isError && 'border-l-danger',
    )"
  >
    <!-- Header -->
    <button
      class="flex w-full items-center justify-between px-2.5 py-1.5 text-left hover:bg-surface transition-colors"
      @click="expanded = !expanded"
    >
      <div class="flex items-center gap-2">
        <!-- Status spinner/icon -->
        <span
          v-if="isRunning"
          class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent border-warning"
        />
        <span v-else class="text-xs font-mono" :class="isError ? 'text-danger' : 'text-success'">
          {{ isError ? '\u2717' : '\u2713' }}
        </span>
        <span class="font-mono font-semibold text-text-primary">{{ toolCall.toolName }}</span>
        <span v-if="filePathHint" class="truncate font-mono text-xs text-text-muted">
          {{ truncate(filePathHint, 50) }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span class="font-mono text-xs" :class="isRunning ? 'text-warning' : isError ? 'text-danger' : 'text-success'">
          {{ isRunning ? 'running...' : isError ? 'failed' : 'done' }}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          class="text-text-muted transition-transform"
          :class="expanded ? 'rotate-180' : ''"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    </button>

    <!-- Expanded body -->
    <div v-if="expanded" class="border-t border-border">
      <!-- Tool-specific renderer -->
      <component
        v-if="rendererComponent"
        :is="rendererComponent"
        :tool-call="toolCall"
      />
      <!-- Default fallback renderer -->
      <component
        v-else
        :is="DefaultRenderer"
        :tool-call="toolCall"
      />
    </div>
  </div>
</template>
```

### Step 2.3: `src/components/chat/ToolRenderers/DefaultToolRenderer.vue`

- [ ] Create default tool renderer

```vue
<!-- src/components/chat/ToolRenderers/DefaultToolRenderer.vue -->
<script setup lang="ts">
import type { ToolCall } from '@xyz-agent/shared'

defineProps<{ toolCall: ToolCall }>()

function parseInput(tc: ToolCall): string {
  try {
    const obj = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(tc.input)
  }
}
</script>

<template>
  <div>
    <!-- Input -->
    <pre
      v-if="toolCall.input"
      class="whitespace-pre-wrap px-2.5 py-2 font-mono text-xs text-text-muted"
    >{{ parseInput(toolCall) }}</pre>

    <!-- Output -->
    <div
      v-if="toolCall.output !== undefined && toolCall.status !== 'running'"
      class="mx-2.5 mb-2 max-h-52 overflow-y-auto rounded-md border border-border bg-surface p-2"
    >
      <pre class="whitespace-pre-wrap font-mono text-xs text-text-muted">{{ toolCall.output }}</pre>
    </div>
  </div>
</template>
```

### Step 2.4: `src/components/chat/ToolRenderers/BashToolRenderer.vue`

- [ ] Create bash-specific renderer (shows command prominently)

```vue
<!-- src/components/chat/ToolRenderers/BashToolRenderer.vue -->
<script setup lang="ts">
import type { ToolCall } from '@xyz-agent/shared'

const props = defineProps<{ toolCall: ToolCall }>()

function getCommand(): string {
  try {
    const obj = typeof props.toolCall.input === 'string'
      ? JSON.parse(props.toolCall.input)
      : props.toolCall.input
    return String(obj.command ?? '')
  } catch {
    return String(props.toolCall.input)
  }
}
</script>

<template>
  <div>
    <!-- Command (prominent) -->
    <div class="px-2.5 py-2">
      <div class="font-mono text-xs text-text-muted mb-1">Command:</div>
      <pre class="whitespace-pre-wrap font-mono text-xs text-text-primary bg-bg-base rounded-md p-2">{{ getCommand() }}</pre>
    </div>

    <!-- Output -->
    <div
      v-if="toolCall.output !== undefined && toolCall.status !== 'running'"
      class="mx-2.5 mb-2"
    >
      <div class="font-mono text-xs text-text-muted mb-1">Output:</div>
      <div class="max-h-52 overflow-y-auto rounded-md border border-border bg-surface p-2">
        <pre class="whitespace-pre-wrap font-mono text-xs text-text-muted">{{ toolCall.output }}</pre>
      </div>
    </div>
  </div>
</template>
```

### Step 2.5: `src/components/chat/ToolRenderers/EditToolRenderer.vue`

- [ ] Create edit-specific renderer (shows diff-style old→new)

```vue
<!-- src/components/chat/ToolRenderers/EditToolRenderer.vue -->
<script setup lang="ts">
import type { ToolCall } from '@xyz-agent/shared'
import { computed } from 'vue'

const props = defineProps<{ toolCall: ToolCall }>()

const parsedInput = computed(() => {
  try {
    return typeof props.toolCall.input === 'string'
      ? JSON.parse(props.toolCall.input)
      : props.toolCall.input
  } catch {
    return {}
  }
})

const filePath = computed(() => String(parsedInput.value.file_path ?? ''))
const oldText = computed(() => String(parsedInput.value.old_text ?? ''))
const newText = computed(() => String(parsedInput.value.new_text ?? ''))
</script>

<template>
  <div>
    <!-- File path -->
    <div class="px-2.5 py-2">
      <div class="font-mono text-xs text-text-muted mb-1">File:</div>
      <code class="font-mono text-xs text-accent">{{ filePath }}</code>
    </div>

    <!-- Old text -->
    <div v-if="oldText" class="px-2.5 py-1">
      <div class="font-mono text-xs text-text-muted mb-1">Old:</div>
      <pre class="whitespace-pre-wrap font-mono text-xs text-danger bg-bg-base rounded-md p-2 max-h-32 overflow-y-auto">{{ oldText }}</pre>
    </div>

    <!-- New text -->
    <div v-if="newText" class="px-2.5 py-1">
      <div class="font-mono text-xs text-text-muted mb-1">New:</div>
      <pre class="whitespace-pre-wrap font-mono text-xs text-success bg-bg-base rounded-md p-2 max-h-32 overflow-y-auto">{{ newText }}</pre>
    </div>
  </div>
</template>
```

### Step 2.6: `src/components/chat/ToolRenderers/ReadToolRenderer.vue`

- [ ] Create read-specific renderer (shows file path + output)

```vue
<!-- src/components/chat/ToolRenderers/ReadToolRenderer.vue -->
<script setup lang="ts">
import type { ToolCall } from '@xyz-agent/shared'
import { computed } from 'vue'

const props = defineProps<{ toolCall: ToolCall }>()

const filePath = computed(() => {
  try {
    const obj = typeof props.toolCall.input === 'string'
      ? JSON.parse(props.toolCall.input)
      : props.toolCall.input
    return String(obj.path ?? obj.file_path ?? '')
  } catch {
    return ''
  }
})
</script>

<template>
  <div>
    <!-- File path -->
    <div class="px-2.5 py-2">
      <div class="font-mono text-xs text-text-muted mb-1">File:</div>
      <code class="font-mono text-xs text-accent">{{ filePath }}</code>
    </div>

    <!-- File content output -->
    <div
      v-if="toolCall.output !== undefined && toolCall.status !== 'running'"
      class="mx-2.5 mb-2"
    >
      <div class="font-mono text-xs text-text-muted mb-1">Content:</div>
      <div class="max-h-64 overflow-y-auto rounded-md border border-border bg-bg-base p-2">
        <pre class="whitespace-pre-wrap font-mono text-xs text-text-muted">{{ toolCall.output }}</pre>
      </div>
    </div>
  </div>
</template>
```

### Step 2.7: Commit

- [ ] `git add -A && git commit -m "feat(chat): tool renderer registry + ToolCallCard dispatch + Bash/Edit/Read/Default renderers"`

---

## Batch 3 — ApprovalCard

> Commit: `feat(chat): ApprovalCard for inline tool approval UI`

### Step 3.1: `src/components/chat/ApprovalCard.vue`

> **NEW**: Inline approval UI for tools that require user permission. Wired via WS protocol (`tool.approve` / `tool.deny` / `tool.always_allow`).

- [ ] Create approval card component

```vue
<!-- src/components/chat/ApprovalCard.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { cn } from '../../design-system/utils'
import { useToast } from '../../composables/useToast'

export interface PendingToolCall {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
}

const props = defineProps<{
  pending: PendingToolCall
}>()

const emit = defineEmits<{
  approve: [toolCallId: string]
  deny: [toolCallId: string]
  alwaysAllow: [toolName: string]
}>()

const { t } = useI18n()
const { info } = useToast()

const dangerLabel = computed(() => {
  switch (props.pending.dangerLevel) {
    case 'danger': return t('chat.danger')
    case 'caution': return t('chat.caution')
    case 'safe': return t('chat.safe')
  }
})

function formatInput(): string {
  try {
    return JSON.stringify(props.pending.input, null, 2)
  } catch {
    return String(props.pending.input)
  }
}
</script>

<template>
  <div
    class="rounded-md border border-border border-l-[3px] bg-surface p-3"
    :class="cn(
      pending.dangerLevel === 'danger' && 'border-l-danger',
      pending.dangerLevel === 'caution' && 'border-l-warning',
      pending.dangerLevel === 'safe' && 'border-l-success',
    )"
  >
    <!-- Header -->
    <div class="flex items-center gap-2 mb-2">
      <span
        class="text-xs font-mono font-semibold"
        :class="cn(
          pending.dangerLevel === 'danger' && 'text-danger',
          pending.dangerLevel === 'caution' && 'text-warning',
          pending.dangerLevel === 'safe' && 'text-success',
        )"
      >
        {{ pending.toolName }}
      </span>
      <span
        class="text-xs font-mono"
        :class="cn(
          pending.dangerLevel === 'danger' && 'text-danger',
          pending.dangerLevel === 'caution' && 'text-warning',
          pending.dangerLevel === 'safe' && 'text-success',
        )"
      >
        {{ pending.dangerLevel }}
      </span>
    </div>

    <!-- Input preview -->
    <pre class="whitespace-pre-wrap text-xs font-mono text-text-muted bg-bg-base rounded-md p-2 max-h-32 overflow-y-auto mb-3">{{ formatInput() }}</pre>

    <!-- Actions -->
    <div class="flex items-center gap-2 justify-end">
      <button
        class="px-3 py-1 text-xs font-mono rounded-md border border-border hover:bg-surface transition-colors text-text-muted"
        @click="emit('alwaysAllow', pending.toolName)"
      >
        {{ t('chat.alwaysAllow') }}
      </button>
      <button
        class="px-3 py-1 text-xs font-mono rounded-md border border-border hover:bg-surface transition-colors text-text-primary"
        @click="emit('deny', pending.toolCallId)"
      >
        {{ t('chat.deny') }}
      </button>
      <button
        class="px-3 py-1 text-xs font-mono rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
        @click="emit('approve', pending.toolCallId)"
      >
        {{ t('chat.approve') }}
      </button>
    </div>
  </div>
</template>
```

### Step 3.2: Commit

- [ ] `git add -A && git commit -m "feat(chat): ApprovalCard — inline tool approval UI"`

---

## Batch 4 — MessageList + ContextBar + ModelPicker

> Commit: `feat(chat): MessageList (virtual scroll), ContextBar, ModelPicker`

### Step 4.1: `src/components/chat/MessageList.vue`

> **Key v3 change**: Only renders `completedMessages` (static). StreamingMessage is rendered separately in ChatView.

- [ ] Create virtual-scroll message list

```vue
<!-- src/components/chat/MessageList.vue -->
<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{
  messages: Message[]
}>()

const scrollRef = ref<HTMLDivElement | null>(null)

const virtualizer = useVirtualizer({
  get count() { return props.messages.length },
  getScrollElement: () => scrollRef.value,
  estimateSize: () => 80,
  overscan: 5,
})

const isNearBottom = ref(true)

function handleScroll() {
  const el = scrollRef.value
  if (!el) return
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100
}

// Auto-scroll to bottom on new messages
watch(
  () => props.messages.length,
  async () => {
    if (!isNearBottom.value) return
    await nextTick()
    virtualizer.scrollToIndex(props.messages.length - 1, { align: 'end' })
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
        class="px-4 py-1"
        :data-index="virtualItem.index"
      >
        <MessageBubble :message="messages[virtualItem.index]" />
      </div>
    </div>
  </div>
</template>
```

### Step 4.2: `src/components/chat/ContextBar.vue`

- [ ] Create context usage progress bar with color thresholds

```vue
<!-- src/components/chat/ContextBar.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '../../design-system/utils'

const props = defineProps<{
  percentage: number
}>()

const barColor = computed(() => {
  if (props.percentage > 85) return 'bg-danger'
  if (props.percentage > 60) return 'bg-warning'
  return 'bg-accent'
})

const textColor = computed(() => {
  if (props.percentage > 85) return 'text-danger'
  if (props.percentage > 60) return 'text-warning'
  return 'text-text-muted'
})
</script>

<template>
  <div class="flex items-center gap-1.5">
    <div class="h-1 w-16 rounded-full bg-border">
      <div
        class="h-full rounded-full transition-all duration-300"
        :class="barColor"
        :style="{ width: `${Math.min(percentage, 100)}%` }"
      />
    </div>
    <span class="font-mono text-xs" :class="textColor">
      {{ percentage.toFixed(0) }}%
    </span>
  </div>
</template>
```

### Step 4.3: `src/components/chat/ModelPicker.vue`

- [ ] Create grouped model dropdown

```vue
<!-- src/components/chat/ModelPicker.vue -->
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useModel } from '../../composables/useModel'
import { cn } from '../../design-system/utils'

const props = defineProps<{
  currentModel: string
}>()

const emit = defineEmits<{
  select: [modelId: string]
}>()

const { models, requestModels, modelsByProvider, currentModelLabel } = useModel()
const open = ref(false)

function toggle() {
  open.value = !open.value
  if (open.value && models.value.length === 0) requestModels()
}

function select(modelId: string) {
  emit('select', modelId)
  open.value = false
}

function handleClickOutside(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('.model-picker-root')) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onUnmounted(() => document.removeEventListener('click', handleClickOutside))
</script>

<template>
  <div class="model-picker-root relative">
    <button
      class="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-xs transition-colors hover:bg-surface"
      :class="open ? 'bg-surface text-text-primary' : 'text-text-muted'"
      @click="toggle"
    >
      <span>{{ currentModelLabel }}</span>
      <svg
        xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="transition-transform" :class="open ? 'rotate-180' : ''"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <!-- Dropdown -->
    <div
      v-if="open"
      class="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-surface py-1 shadow-lg"
    >
      <template v-for="[provider, providerModels] of modelsByProvider" :key="provider">
        <div class="px-3 pt-2 pb-1 font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">
          {{ provider }}
        </div>
        <button
          v-for="m in providerModels"
          :key="m.id"
          class="w-full flex items-center justify-between px-3 py-1 font-mono text-xs hover:bg-surface transition-colors"
          :class="m.id === currentModel ? 'text-accent' : 'text-text-primary'"
          @click="select(m.id)"
        >
          <span class="truncate">{{ m.name }}</span>
        </button>
      </template>
    </div>
  </div>
</template>
```

### Step 4.4: Commit

- [ ] `git add -A && git commit -m "feat(chat): MessageList (virtual scroll), ContextBar, ModelPicker"`

---

## Batch 5 — SlashMenu (populated) + ChatInput

> Commit: `feat(chat): SlashMenu populated from registry + ChatInput with ModelPicker + ContextBar`

### Step 5.1: `src/components/chat/SlashMenu.vue`

> **Key v3 change**: Now reads from `useSlashCommands()` registry. Not empty.

- [ ] Create populated slash menu

```vue
<!-- src/components/chat/SlashMenu.vue -->
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSlashCommands } from '../../composables/useSlashCommands'
import { cn } from '../../design-system/utils'

const props = defineProps<{
  visible: boolean
  filter: string
}>()

const emit = defineEmits<{
  close: []
  select: [name: string]
}>()

const { commands, filterByPrefix } = useSlashCommands()
const selectedIndex = ref(0)

const filteredCommands = computed(() => {
  if (!props.filter) return commands.value
  return filterByPrefix.value(props.filter)
})

watch(() => filteredCommands.value.length, () => {
  selectedIndex.value = 0
})

function handleKeydown(e: KeyboardEvent) {
  if (!props.visible || filteredCommands.value.length === 0) return
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      selectedIndex.value = Math.max(0, selectedIndex.value - 1)
      break
    case 'ArrowDown':
      e.preventDefault()
      selectedIndex.value = Math.min(filteredCommands.value.length - 1, selectedIndex.value + 1)
      break
    case 'Enter':
      e.preventDefault()
      if (filteredCommands.value[selectedIndex.value]) {
        emit('select', filteredCommands.value[selectedIndex.value].name)
      }
      break
    case 'Escape':
      e.preventDefault()
      emit('close')
      break
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <div
    v-if="visible"
    class="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-md border border-border bg-surface px-1 py-1 shadow-lg"
  >
    <div v-if="filteredCommands.length === 0" class="px-3 py-3 text-center font-mono text-xs text-text-muted">
      No matching commands
    </div>
    <div v-else class="space-y-0.5">
      <button
        v-for="(cmd, i) in filteredCommands"
        :key="cmd.name"
        class="flex items-center gap-3 w-full rounded-sm px-3 py-1.5 text-left transition-colors"
        :class="cn(
          i === selectedIndex ? 'bg-accent-light text-text-primary' : 'text-text-muted hover:bg-surface',
        )"
        @click="emit('select', cmd.name)"
        @mouseenter="selectedIndex = i"
      >
        <span class="font-mono text-xs text-accent">/{{ cmd.name }}</span>
        <span class="text-xs text-text-muted">{{ cmd.description }}</span>
      </button>
    </div>
  </div>
</template>
```

### Step 5.2: `src/components/chat/ChatInput.vue`

> **Key v3 change**: Integrates ModelPicker, ContextBar (with compact trigger), SlashMenu (populated from registry).

- [ ] Create full chat input

```vue
<!-- src/components/chat/ChatInput.vue -->
<script setup lang="ts">
import { ref, nextTick, computed } from 'vue'
import ModelPicker from './ModelPicker.vue'
import ContextBar from './ContextBar.vue'
import SlashMenu from './SlashMenu.vue'
import { useChatStore } from '../../stores/chat'
import { useModel } from '../../composables/useModel'
import { useContext } from '../../composables/useContext'
import { useSlashCommands } from '../../composables/useSlashCommands'
import { cn } from '../../design-system/utils'

const props = defineProps<{
  isStreaming: boolean
}>()

const emit = defineEmits<{
  send: [content: string]
  cancel: []
  'select-model': [modelId: string]
}>()

const chatStore = useChatStore()
const { currentModelId, switchModel } = useModel()
const { usagePercent, compactRecommended, triggerCompact } = useContext()
const { find } = useSlashCommands()

const inputText = ref('')
const isFocused = ref(false)
const isComposing = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const MAX_HEIGHT = 140

// Slash menu
const showSlashMenu = ref(false)
const slashFilter = ref('')

const canSend = computed(() => inputText.value.trim().length > 0)

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + 'px'
}

function handleInput() {
  autoResize()
  // Slash menu trigger
  const text = inputText.value
  if (text.startsWith('/')) {
    showSlashMenu.value = true
    slashFilter.value = text.slice(1)
  } else {
    showSlashMenu.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !isComposing.value && !showSlashMenu.value) {
    e.preventDefault()
    handleSend()
  }
}

function handleSend() {
  const trimmed = inputText.value.trim()
  if (!trimmed) return

  // Check if it's a slash command
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(' ')
    const cmdName = parts[0].slice(1)
    const cmdArgs = parts.slice(1).join(' ')
    const cmd = find(cmdName)
    if (cmd) {
      cmd.execute(cmdArgs)
      inputText.value = ''
      showSlashMenu.value = false
      nextTick(autoResize)
      return
    }
    // Unknown command — send as regular message
  }

  emit('send', trimmed)
  inputText.value = ''
  showSlashMenu.value = false
  nextTick(autoResize)
}

function handleSlashSelect(name: string) {
  inputText.value = ''
  showSlashMenu.value = false
  const cmd = find(name)
  if (cmd) cmd.execute('')
  nextTick(autoResize)
}

function handleSelectModel(modelId: string) {
  switchModel(modelId)
}
</script>

<template>
  <div class="border-t border-border bg-bg-base px-4 py-3 relative">
    <!-- Slash menu -->
    <SlashMenu
      v-if="showSlashMenu"
      :visible="showSlashMenu"
      :filter="slashFilter"
      @close="showSlashMenu = false"
      @select="handleSlashSelect"
    />

    <!-- Textarea -->
    <div
      class="flex items-start gap-3"
      :class="isFocused ? 'border-b-2 border-accent pb-px' : 'border-b-2 border-transparent pb-px'"
    >
      <span class="shrink-0 font-mono text-sm text-accent mt-1">&gt;</span>

      <textarea
        ref="textareaRef"
        v-model="inputText"
        :disabled="isStreaming"
        :placeholder="'Input message...'"
        class="min-h-[1.75rem] max-h-[140px] flex-1 resize-none bg-transparent font-mono text-sm leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none"
        rows="1"
        @input="handleInput"
        @keydown="handleKeydown"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @focus="isFocused = true"
        @blur="isFocused = false"
      />

      <!-- Send / Stop -->
      <button
        v-if="!isStreaming"
        class="shrink-0 px-2 py-1 rounded-sm text-xs font-mono text-text-muted hover:bg-surface hover:text-accent disabled:opacity-30 transition-colors mt-1"
        :disabled="!canSend"
        @click="handleSend"
      >
        Send
      </button>
      <button
        v-else
        class="shrink-0 px-2 py-1 rounded-sm text-xs font-mono text-danger hover:bg-surface transition-colors mt-1"
        @click="emit('cancel')"
      >
        Stop
      </button>
    </div>

    <!-- Toolbar -->
    <div class="mt-2 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <!-- Upload placeholder -->
        <button class="font-mono text-xs text-text-muted hover:text-text-primary disabled:opacity-30" disabled>
          +
        </button>
      </div>

      <div class="flex items-center gap-3">
        <!-- Context usage + compact trigger -->
        <div class="flex items-center gap-1.5 font-mono text-xs text-text-muted">
          <span>ctx:</span>
          <ContextBar :percentage="usagePercent" />
          <button
            v-if="compactRecommended"
            class="text-warning hover:underline"
            @click="triggerCompact"
          >
            compact
          </button>
        </div>

        <!-- Model picker -->
        <ModelPicker
          :current-model="currentModelId"
          @select="handleSelectModel"
        />
      </div>
    </div>
  </div>
</template>
```

### Step 5.3: Commit

- [ ] `git add -A && git commit -m "feat(chat): SlashMenu populated + ChatInput with ModelPicker, ContextBar, compact trigger"`

---

## Batch 6 — Integrate into ChatView

> Commit: `refactor(chat): integrate all chat components into ChatView with stable list + streaming pattern`

### Step 6.1: Update `src/components/chat/ChatView.vue`

> **Key v3 architecture**: Two-zone rendering — `MessageList` (static completedMessages) + `StreamingMessage` (reactive streaming) + `ChatInput`.

- [ ] Rewrite ChatView with complete component integration

```vue
<!-- src/components/chat/ChatView.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { useChat } from '../../composables/useChat'
import MessageList from './MessageList.vue'
import StreamingMessage from './StreamingMessage.vue'
import ChatInput from './ChatInput.vue'
import ApprovalCard from './ApprovalCard.vue'
import { wsClient } from '../../lib/ws-client'

const { t } = useI18n()
const chatStore = useChatStore()
const { sendMessage, abort } = useChat()

// Approval state (P1: single pending tool)
const pendingApproval = ref<ApprovalCard['pending'] | null>(null)

// Wire approval events
function handleApprove(toolCallId: string) {
  wsClient.send({
    type: 'tool.approve',
    id: `req-${Date.now()}`,
    payload: { sessionId: chatStore.currentSessionId, toolCallId },
  })
  pendingApproval.value = null
}

function handleDeny(toolCallId: string) {
  wsClient.send({
    type: 'tool.deny',
    id: `req-${Date.now()}`,
    payload: { sessionId: chatStore.currentSessionId, toolCallId },
  })
  pendingApproval.value = null
}

function handleAlwaysAllow(toolName: string) {
  wsClient.send({
    type: 'tool.always_allow',
    id: `req-${Date.now()}`,
    payload: { sessionId: chatStore.currentSessionId, toolName },
  })
  pendingApproval.value = null
}
</script>

<template>
  <div data-slot="chat-view" class="flex flex-col h-full bg-bg-base">
    <!-- Message area: stable list + streaming -->
    <div class="flex-1 overflow-hidden flex flex-col">
      <!-- Empty state -->
      <div
        v-if="chatStore.completedMessages.length === 0 && !chatStore.streamingMessage"
        class="flex-1 flex flex-col items-center justify-center text-center px-8"
      >
        <h2 class="text-lg font-medium text-text-primary mb-2">{{ t('chat.emptyTitle') }}</h2>
        <p class="text-sm text-text-muted max-w-md">{{ t('chat.emptySubtitle') }}</p>
      </div>

      <template v-else>
        <!-- Zone 1: Completed messages (static, no reactivity churn) -->
        <MessageList :messages="chatStore.completedMessages" />

        <!-- Zone 2: Streaming message (reactive) -->
        <div v-if="chatStore.streamingMessage" class="px-4 py-1">
          <StreamingMessage :message="chatStore.streamingMessage" />
        </div>

        <!-- Approval card (if pending) -->
        <div v-if="pendingApproval" class="px-4 py-2">
          <ApprovalCard
            :pending="pendingApproval"
            @approve="handleApprove"
            @deny="handleDeny"
            @always-allow="handleAlwaysAllow"
          />
        </div>
      </template>
    </div>

    <!-- Input area -->
    <ChatInput
      :is-streaming="chatStore.isGenerating"
      @send="sendMessage"
      @cancel="abort"
    />
  </div>
</template>
```

### Step 6.2: Verify build

- [ ] `npm run build` passes
- [ ] `npm run dev` renders chat correctly
- [ ] No hardcoded colors (ESLint taste rules)
- [ ] No native form elements (except textarea in ChatInput which is acceptable for auto-resize)

### Step 6.3: Commit

- [ ] `git add -A && git commit -m "refactor(chat): integrate all chat components — stable list + streaming + approval + slash commands"`

---

## File Tree Summary

```
src/
  lib/
    register-tool-renderers.ts         ← NEW (Batch 2)
  components/chat/
    ChatView.vue                       ← MODIFIED (Batch 6: full integration)
    MessageList.vue                    ← NEW (Batch 4: virtual scroll, static completedMessages)
    StreamingMessage.vue               ← NEW (Batch 1: live streaming with rAF)
    MessageBubble.vue                  ← NEW (Batch 1: markdown rendering)
    ToolCallCard.vue                   ← NEW (Batch 2: registry dispatch)
    ThinkingBlock.vue                  ← NEW (Batch 1: collapsible thinking)
    ChatInput.vue                      ← NEW (Batch 5: full input with toolbar)
    ModelPicker.vue                    ← NEW (Batch 4: grouped model dropdown)
    ContextBar.vue                     ← NEW (Batch 4: usage progress bar)
    SlashMenu.vue                      ← NEW (Batch 5: populated from registry)
    ApprovalCard.vue                   ← NEW (Batch 3: inline tool approval)
    ToolRenderers/
      DefaultToolRenderer.vue          ← NEW (Batch 2)
      BashToolRenderer.vue             ← NEW (Batch 2)
      EditToolRenderer.vue             ← NEW (Batch 2)
      ReadToolRenderer.vue             ← NEW (Batch 2)
```

## Complete Checklist

- [ ] Install `@tanstack/vue-virtual` (done in plan-02)
- [ ] Create `MessageBubble.vue` — markdown rendered content
- [ ] Create `StreamingMessage.vue` — live streaming with cursor
- [ ] Create `ThinkingBlock.vue` — collapsible thinking
- [ ] Create `ToolCallCard.vue` — registry dispatch
- [ ] Create `DefaultToolRenderer.vue`
- [ ] Create `BashToolRenderer.vue`
- [ ] Create `EditToolRenderer.vue`
- [ ] Create `ReadToolRenderer.vue`
- [ ] Create `register-tool-renderers.ts`
- [ ] Create `ApprovalCard.vue`
- [ ] Create `MessageList.vue` — virtual scroll
- [ ] Create `ContextBar.vue` — usage progress bar
- [ ] Create `ModelPicker.vue` — grouped dropdown
- [ ] Create `SlashMenu.vue` — populated from registry
- [ ] Create `ChatInput.vue` — textarea + toolbar
- [ ] Update `ChatView.vue` — full integration
- [ ] `npm run build` passes
- [ ] `npm run dev` renders correctly
- [ ] ESLint taste rules pass
