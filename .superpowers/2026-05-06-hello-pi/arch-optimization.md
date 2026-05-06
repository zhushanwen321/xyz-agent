# Architecture Optimization: xyz-agent Phase 1

**Date**: 2026-05-06 | **Based on**: spec-v2.md + arch-frontend.md + arch-backend.md + 4 reference project findings
**Status**: Design Proposal — accompanies but does not modify spec-v2

> This document captures optimization opportunities discovered by studying claude-code-source-code, pi-mono (web-ui + coding-agent), openhanako, and opencode. Each optimization is prioritized by impact on P1 deliverables and mapped to specific spec-v2 sections that need updating during implementation.

---

## Table of Contents

1. [P0 — High Priority (Core Experience)](#1-p0--high-priority-core-experience)
   - [1.1 Stable List + Streaming Container Split](#11-stable-list--streaming-container-split)
   - [1.2 rAF Batching for Streaming Deltas](#12-raf-batching-for-streaming-deltas)
   - [1.3 Tool Renderer Registry](#13-tool-renderer-registry)
2. [P1 — Medium Priority (Extensibility & UX)](#2-p1--medium-priority-extensibility--ux)
   - [2.1 Tool Approval Workflow](#21-tool-approval-workflow)
   - [2.2 Steering/Follow-up Queue System](#22-steeringfollow-up-queue-system)
   - [2.3 Split Session Metadata/Data](#23-split-session-metadata-data)
   - [2.4 Slash Command Registry](#24-slash-command-registry)
   - [2.5 Context Window Management](#25-context-window-management)
3. [P2 — Low Priority (Future-Proofing)](#3-p2--low-priority-future-proofing)
   - [3.1 Permission Model](#31-permission-model)
   - [3.2 Custom Message Types](#32-custom-message-types)
   - [3.3 Storage Backend Abstraction](#33-storage-backend-abstraction)
   - [3.4 Headless/Embeddable RPC Mode](#34-headlessembeddable-rpc-mode)
4. [spec-v2 Modification Map](#4-spec-v2-modification-map)

---

## 1. P0 — High Priority (Core Experience)

These optimizations directly affect the fundamental user experience — rendering performance, streaming smoothness, and tool display quality. Implement before or during the first integration pass.

### 1.1 Stable List + Streaming Container Split

**Source**: pi-mono web-ui architecture

**Problem**: The current spec renders all messages in a single reactive `messages: Message[]` array in `useChatStore`. Every streaming delta (arriving at ~60/sec) mutates the last message's `content` string. Vue's reactivity system then triggers a re-render of the entire `MessageList` — including all completed messages above. For a conversation with 50+ messages, this causes visible jank.

**Pattern**: Split the message list into two zones:

1. **`completedMessages`** — Static array of finalized messages. Never mutated during streaming. Rendered once, then untouched. Reactivity is effectively frozen for these items.
2. **`streamingMessage`** — A single reactive object for the currently streaming assistant response. This is the only thing that updates on every delta.

```
┌─────────────────────────────────────┐
│ completedMessages (static)           │
│ ┌─────────────────────────────────┐ │
│ │ Message 1 (user)               │ │  ← rendered once, never re-renders
│ ├─────────────────────────────────┤ │
│ │ Message 2 (assistant, final)   │ │  ← rendered once, never re-renders
│ ├─────────────────────────────────┤ │
│ │ ToolCall 1 (done)              │ │  ← rendered once, never re-renders
│ ├─────────────────────────────────┤ │
│ │ Message 3 (assistant, final)   │ │  ← rendered once, never re-renders
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ streamingMessage (reactive)         │
│ ┌─────────────────────────────────┐ │
│ │ Message 4 (assistant, active)  │ │  ← re-renders on every delta
│ │ "Let me analyze the cod█"      │ │     but only THIS component
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

**Implementation — Store Changes** (`stores/chat.ts`):

```typescript
// BEFORE (spec-v2 current):
interface ChatState {
  messages: Message[]              // Single array — problem!
  isGenerating: boolean
  streamingText: string
}

// AFTER (optimized):
interface ChatState {
  completedMessages: Message[]     // Frozen once message is done
  streamingMessage: StreamingAssistantMessage | null  // Only this updates
  isGenerating: boolean
  pendingToolCalls: ToolCall[]     // Tool calls in the current streaming turn
}

interface StreamingAssistantMessage {
  id: string
  textContent: string              // Accumulated text delta
  thinkingContent: string          // Accumulated thinking delta
  toolCalls: ToolCall[]            // Tool calls started during this message
  startedAt: number
}
```

**Implementation — Actions**:

```typescript
// When message.complete arrives:
function finalizeStreamingMessage(usage: Usage, stopReason: string) {
  const streaming = chatState.streamingMessage
  if (!streaming) return

  // Build final Message from streaming data
  const finalMessage: Message = {
    id: streaming.id,
    role: 'assistant',
    content: streaming.textContent,
    thinking: streaming.thinkingContent,
    toolCalls: streaming.toolCalls,
    usage,
    stopReason,
    timestamp: Date.now(),
  }

  // Move to completed (triggers ONE re-render of the list)
  chatState.completedMessages = [...chatState.completedMessages, finalMessage]
  chatState.streamingMessage = null
}

// When user sends a message:
function addUserMessage(content: string) {
  const msg: Message = {
    id: generateId(),
    role: 'user',
    content,
    timestamp: Date.now(),
  }
  chatState.completedMessages = [...chatState.completedMessages, msg]
}
```

**Implementation — Template Changes** (`MessageList.vue`):

```vue
<template>
  <ScrollArea ref="scrollRef">
    <!-- Stable zone: never re-renders during streaming -->
    <MessageBubble
      v-for="msg in chatStore.completedMessages"
      :key="msg.id"
      :message="msg"
    />

    <!-- Streaming zone: only this re-renders -->
    <template v-if="chatStore.streamingMessage">
      <ThinkingBlock
        v-if="chatStore.streamingMessage.thinkingContent"
        :content="chatStore.streamingMessage.thinkingContent"
        :streaming="true"
      />
      <StreamingText
        :text="chatStore.streamingMessage.textContent"
        :streaming="true"
      />
      <ToolCallCard
        v-for="tc in chatStore.streamingMessage.toolCalls"
        :key="tc.id"
        :tool-call="tc"
      />
    </template>
  </ScrollArea>
</template>
```

**Performance impact**: Completed messages (which can be 50-200+ DOM nodes) are completely stable during streaming. Only the streaming zone (1-3 components) re-renders. Reduces per-frame React/Vue work from O(n) to O(1) where n = total message count.

**Data flow**:

```
WS: message.text_delta { delta: "你" }
  → eventBus → useChat handler
  → chatStore.streamingMessage.textContent += delta
  → Vue reactivity triggers ONLY StreamingText.vue (not MessageBubble instances above)
```

**spec-v2 impact**: Sections 4.4 (Chat View), 7.1 (Store), arch-frontend §3a (Send Message Flow), §4.1 (useChatStore)

---

### 1.2 rAF Batching for Streaming Deltas

**Source**: pi-mono web-ui performance optimization

**Problem**: LLM streaming delivers text deltas at ~60 tokens/sec. Each `message.text_delta` WS event triggers a store mutation → Vue re-render → DOM update. Even with the stable list split (§1.1), the `StreamingText` component still re-renders ~60 times per second. Most frames are wasted — the user can't perceive individual characters at that speed, and the browser composites at most 60fps.

**Pattern**: Collect all deltas received within one animation frame (~16ms) into a buffer. Apply the buffer as a single mutation once per frame via `requestAnimationFrame`.

```
Timeline without batching (60 re-renders/sec):
  ──Δ1──Δ2──Δ3──Δ4──Δ5──Δ6──Δ7──Δ8──Δ9──Δ10── (each triggers re-render)
  ────frame 1─────────frame 2─────────frame 3──

Timeline with rAF batching (≤60 re-renders/sec, typically ~16):
  ──Δ1Δ2Δ3──│──Δ4Δ5Δ6──│──Δ7Δ8Δ9Δ10──│
            │          │             │
          rAF flush   rAF flush    rAF flush
  ────frame 1─────frame 2──────frame 3──
```

**Implementation — Composable** (`composables/useRafBatcher.ts`):

```typescript
import { ref, onUnmounted } from 'vue'

/**
 * Batches rapid string updates into requestAnimationFrame flushes.
 * Reduces re-renders from ~60/sec (one per delta) to ~16/sec (one per frame).
 */
export function useRafBatcher() {
  let buffer = ''
  let rafId: number | null = null

  // The flushed output — components bind to this
  const flushed = ref('')

  function flush() {
    if (buffer.length > 0) {
      flushed.value += buffer
      buffer = ''
    }
    rafId = null
  }

  function append(delta: string) {
    buffer += delta
    if (rafId === null) {
      rafId = requestAnimationFrame(flush)
    }
  }

  function reset(value = '') {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    buffer = ''
    flushed.value = value
  }

  onUnmounted(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
    }
  })

  return { flushed, append, reset }
}
```

**Integration with useChat** (`composables/useChat.ts`):

```typescript
// Inside useChat setup:
const textBatcher = useRafBatcher()
const thinkingBatcher = useRafBatcher()

// Event handler — just buffer, don't mutate store on every delta
function handleTextDelta(msg: ServerMessage) {
  const { delta } = msg.payload as { delta: string }
  textBatcher.append(delta)
}

// The batcher's flushed ref is the streaming message's text
// Link it to the streaming message in the store:
watch(() => textBatcher.flushed.value, (text) => {
  if (chatStore.streamingMessage) {
    chatStore.streamingMessage.textContent = text
  }
})
```

**Alternative — simpler approach**: Keep the buffer in the store but use a debounced write:

```typescript
// stores/chat.ts
let deltaBuffer = ''
let rafId: number | null = null

function appendDelta(delta: string) {
  deltaBuffer += delta
  if (rafId === null) {
    rafId = requestAnimationFrame(() => {
      if (streamingMessage.value) {
        streamingMessage.value.textContent += deltaBuffer
      }
      deltaBuffer = ''
      rafId = null
    })
  }
}
```

**Performance impact**: Reduces Vue re-renders from ~60/sec to ~16/sec during streaming. CPU usage drops proportionally. The user perceives identical text appearance speed (both approaches complete within the same animation frame).

**Note on interaction with §1.1**: rAF batching complements the stable list split. The split eliminates re-renders of completed messages; rAF batching reduces re-renders of the streaming message itself.

**spec-v2 impact**: Section 7.1 (useChatStore actions — `appendDelta` becomes buffered), arch-frontend §3a (Send Message Flow — add batching step)

---

### 1.3 Tool Renderer Registry

**Source**: pi-mono coding-agent tool rendering, claude-code tool display

**Problem**: The current spec has a single `ToolCallCard.vue` component responsible for rendering all tool types. As tool diversity grows (read, bash, edit, write, grep, find, ls, plus future custom tools), one component becomes a massive switch/case mess. Each tool has unique display needs:

- `read` → show file path + content preview
- `bash` → show command + output with exit code
- `edit` → show diff view (old/new)
- `write` → show file path + content preview
- `grep` → show search pattern + match results
- `find` → show directory tree result
- Future tools → unknown display needs

**Pattern**: Registry pattern — `Map<string, ToolRenderer>` where each tool name maps to a specialized renderer component.

```
ToolCallCard.vue (BEFORE — monolithic):
┌─ switch on toolCall.toolName
│   case "read":   → render file viewer
│   case "bash":   → render terminal output
│   case "edit":   → render diff view
│   case "write":  → render file preview
│   case "grep":   → render search results
│   default:       → generic "tool ran" card
└─ 200+ lines of template logic

ToolRendererRegistry (AFTER — composable):
┌─────────────────────────────────────┐
│ toolRenderers: Map<string, Component>│
│   "read"   → ReadToolRenderer.vue    │
│   "bash"   → BashToolRenderer.vue    │
│   "edit"   → EditToolRenderer.vue    │
│   "write"  → WriteToolRenderer.vue   │
│   "grep"   → GrepToolRenderer.vue    │
│   default  → GenericToolRenderer.vue │
└─────────────────────────────────────┘
```

**Implementation — Registry** (`composables/useToolRenderer.ts`):

```typescript
import { type Component, markRaw } from 'vue'
import GenericToolRenderer from '@/components/chat/tools/GenericToolRenderer.vue'
import ReadToolRenderer from '@/components/chat/tools/ReadToolRenderer.vue'
import BashToolRenderer from '@/components/chat/tools/BashToolRenderer.vue'
import EditToolRenderer from '@/components/chat/tools/EditToolRenderer.vue'
import WriteToolRenderer from '@/components/chat/tools/WriteToolRenderer.vue'

// markRaw prevents Vue from making the component objects reactive (unnecessary overhead)
const registry = new Map<string, Component>()

export function registerToolRenderer(toolName: string, component: Component) {
  registry.set(toolName, markRaw(component))
}

export function getToolRenderer(toolName: string): Component {
  return registry.get(toolName) ?? markRaw(GenericToolRenderer)
}

// Register built-in renderers (called once at app init)
export function initToolRenderers() {
  registerToolRenderer('read', ReadToolRenderer)
  registerToolRenderer('bash', BashToolRenderer)
  registerToolRenderer('edit', EditToolRenderer)
  registerToolRenderer('write', WriteToolRenderer)
  // "grep", "find", "ls" use GenericToolRenderer until specialized
}
```

**Implementation — ToolRenderer Contract**:

Each tool renderer receives the same props interface:

```typescript
// All tool renderers must accept these props
interface ToolRendererProps {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>   // Parsed tool arguments
  output?: string                   // Tool result (undefined while running)
  status: 'running' | 'completed' | 'error'
  isExpanded: boolean
}
```

**Implementation — Dynamic Rendering in ToolCallCard** (now a thin shell):

```vue
<!-- ToolCallCard.vue — becomes a thin wrapper -->
<script setup lang="ts">
import { getToolRenderer } from '@/composables/useToolRenderer'
import type { ToolCall } from '@/types/message'

const props = defineProps<{ toolCall: ToolCall }>()
const isExpanded = ref(false)

const renderer = computed(() => getToolRenderer(props.toolCall.toolName))
</script>

<template>
  <div class="tool-call-card rounded-md border p-2">
    <!-- Collapsed header (always shown) -->
    <div
      class="flex items-center gap-2 cursor-pointer"
      @click="isExpanded = !isExpanded"
    >
      <Badge :variant="toolCall.status === 'completed' ? 'success' : 'accent'" :dot="true" />
      <span class="font-mono text-sm text-accent">{{ toolCall.toolName }}</span>
      <!-- Tool-specific summary line -->
      <ToolSummaryLine :tool-call="toolCall" />
    </div>

    <!-- Expanded detail (dynamic renderer) -->
    <div v-if="isExpanded" class="mt-2">
      <component
        :is="renderer"
        :tool-call-id="toolCall.id"
        :tool-name="toolCall.toolName"
        :input="toolCall.input"
        :output="toolCall.output"
        :status="toolCall.status"
        :is-expanded="isExpanded"
      />
    </div>
  </div>
</template>
```

**Example — BashToolRenderer**:

```vue
<!-- tools/BashToolRenderer.vue -->
<script setup lang="ts">
import type { ToolRendererProps } from '@/types/tool-renderer'

const props = defineProps<ToolRendererProps>()
const command = computed(() => (props.input as { command: string }).command ?? '')
const isRunning = computed(() => props.status === 'running')
</script>

<template>
  <div class="bash-renderer">
    <div v-if="command" class="font-mono text-sm bg-bg-base rounded p-2">
      <span class="text-text-muted">$ </span>
      <span>{{ command }}</span>
    </div>
    <div v-if="output" class="font-mono text-sm mt-2 max-h-64 overflow-auto">
      <pre class="whitespace-pre-wrap text-text-primary">{{ output }}</pre>
    </div>
    <div v-if="isRunning" class="text-text-muted text-sm mt-1 animate-pulse">
      Running…
    </div>
  </div>
</template>
```

**Example — EditToolRenderer** (diff view):

```vue
<!-- tools/EditToolRenderer.vue -->
<script setup lang="ts">
import type { ToolRendererProps } from '@/types/tool-renderer'

const props = defineProps<ToolRendererProps>()
// Parse edit-specific input
const filePath = computed(() => (props.input as { file_path: string }).file_path ?? '')
const oldText = computed(() => (props.input as { old_text: string }).old_text ?? '')
const newText = computed(() => (props.input as { new_text: string }).new_text ?? '')
</script>

<template>
  <div class="edit-renderer">
    <div class="text-sm text-text-muted font-mono">{{ filePath }}</div>
    <div class="mt-2 font-mono text-sm border rounded overflow-auto max-h-64">
      <!-- Simple diff display: red for removed, green for added -->
      <div v-if="oldText" class="bg-danger/10 text-danger p-2 whitespace-pre-wrap">- {{ oldText }}</div>
      <div v-if="newText" class="bg-success/10 text-success p-2 whitespace-pre-wrap">+ {{ newText }}</div>
    </div>
  </div>
</template>
```

**File structure for tool renderers**:

```
src/components/chat/tools/
├── GenericToolRenderer.vue      # Fallback for unknown tools
├── BashToolRenderer.vue         # Terminal command + output
├── ReadToolRenderer.vue         # File viewer
├── EditToolRenderer.vue         # Diff view
├── WriteToolRenderer.vue        # File write preview
├── GrepToolRenderer.vue         # Search results (P2)
└── ToolSummaryLine.vue          # One-line collapsed summary per tool
```

**spec-v2 impact**: Section 4.4 (Chat View — tool call rendering), arch-frontend §2 (Component Dependency Graph — add tools/ directory), spec-v2 project structure (add `components/chat/tools/`)

---

## 2. P1 — Medium Priority (Extensibility & UX)

These optimizations improve extensibility, safety, and user experience. Implement during P1 or early P2.

### 2.1 Tool Approval Workflow

**Source**: claude-code-source-code permission model

**Problem**: Currently, all tool calls execute immediately when the agent decides to use them. For dangerous tools (`bash` with `rm -rf`, `write` to critical files), there's no user confirmation gate. The user only sees the tool call after it has already executed (in the `tool_call_end` event). This is a safety risk — a misaligned agent could execute destructive commands.

**Pattern**: Insert an approval gate between the LLM requesting a tool call and the actual execution. The agent's tool use request is shown to the user, who can approve, deny, or modify before execution proceeds.

```
Agent decides to use tool
  → LLM emits toolcall_start (tool name + args)
  → Sidecar sends message.tool_call_pending (NEW event)
  → Frontend shows approval dialog
  → User clicks: Approve / Deny / Always Allow
  → Frontend sends tool.approve or tool.deny (NEW messages)
  → Sidecar relays to pi (or executes directly)
  → Tool executes → message.tool_call_end
```

**Protocol additions** (`shared/protocol.ts`):

```typescript
// NEW: Sidecar → Client (replaces immediate tool_call_start for dangerous tools)
interface ToolCallPendingEvent {
  type: 'message.tool_call_pending'
  payload: {
    sessionId: string
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    dangerLevel: 'safe' | 'caution' | 'danger'  // Tool classification
    autoApproved: boolean  // If true, already executed (whitelisted)
  }
}

// NEW: Client → Sidecar
interface ToolApproveMessage {
  type: 'tool.approve'
  payload: { sessionId: string; toolCallId: string }
}

interface ToolDenyMessage {
  type: 'tool.deny'
  payload: { sessionId: string; toolCallId: string; reason?: string }
}

interface ToolAlwaysAllowMessage {
  type: 'tool.always_allow'
  payload: { sessionId: string; toolName: string }
}
```

**Tool danger classification**:

| Tool | Danger Level | Default Behavior |
|------|-------------|-----------------|
| `read` | `safe` | Auto-approve |
| `grep`, `find`, `ls` | `safe` | Auto-approve |
| `bash` | `caution` | Require approval (unless whitelisted) |
| `edit` | `caution` | Require approval |
| `write` | `danger` | Always require approval |

**Frontend component** (`ToolApprovalDialog.vue`):

```vue
<script setup lang="ts">
interface Props {
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
}
const props = defineProps<Props>()
const emit = defineEmits<{
  approve: []
  deny: []
  alwaysAllow: []
}>()

const dangerColors = {
  safe: 'text-success',
  caution: 'text-warning',
  danger: 'text-danger',
}
</script>

<template>
  <Dialog :open="true" @update:open="emit('deny')">
    <div class="p-4 space-y-3">
      <div class="flex items-center gap-2">
        <Badge :variant="dangerLevel === 'danger' ? 'danger' : 'warning'" :dot="true" />
        <span class="font-mono">{{ toolName }}</span>
        <span :class="dangerColors[dangerLevel]">{{ dangerLevel }}</span>
      </div>
      <pre class="text-sm bg-bg-base rounded p-2 max-h-48 overflow-auto">{{ JSON.stringify(input, null, 2) }}</pre>
      <div class="flex gap-2 justify-end">
        <Button variant="ghost" @click="emit('deny')">Deny</Button>
        <Button variant="ghost" @click="emit('alwaysAllow')">Always Allow</Button>
        <Button variant="primary" @click="emit('approve')">Approve</Button>
      </div>
    </div>
  </Dialog>
</template>
```

**Sidecar changes** (`server.ts`):

```typescript
// When pi emits tool_execution_start:
// Instead of immediately forwarding to frontend,
// check if the tool requires approval
function handleToolExecutionStart(event: ToolExecutionStartEvent) {
  const toolConfig = getToolConfig(event.toolName)

  if (toolConfig.requiresApproval && !toolConfig.isWhitelisted) {
    // Block execution until user approves
    pendingApprovals.set(event.toolCallId, event)
    sendToWs(ws, {
      type: 'message.tool_call_pending',
      payload: {
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
        dangerLevel: toolConfig.dangerLevel,
        autoApproved: false,
      },
    })
    // Don't proceed with execution until tool.approve arrives
  } else {
    // Auto-approve safe tools
    proceedWithToolExecution(event)
  }
}
```

**spec-v2 impact**: Section 5.2 (WS Protocol — add tool.approve/deny/pending messages), Section 4.4 (Chat View — add approval dialog), arch-backend §4 (Routing Table — add tool approval handlers)

---

### 2.2 Steering/Follow-up Queue System

**Source**: pi-mono coding-agent steering queue, pi SDK `streamingBehavior` option

**Problem**: While the agent is streaming a response, the user has no way to intervene. They must wait for the entire response to complete before sending a correction or follow-up. For long agent turns (multi-tool calls), this can be 30+ seconds of waiting. Two interaction modes are needed:

1. **Steer** — Inject a message mid-stream to redirect the agent's current work. "Stop what you're doing and focus on X instead."
2. **Follow-up** — Queue a message to be sent automatically after the current turn completes. "When you're done with this, also check Y."

**pi SDK already supports this**: `session.prompt()` accepts `streamingBehavior: "steer" | "followUp"`, and `AgentSessionEvent` includes `queue_update` events with current `steering` and `followUp` queues.

**Protocol additions**:

```typescript
// Client → Sidecar: Queue a message during streaming
interface MessageSteerMessage {
  type: 'message.steer'
  payload: { sessionId: string; content: string }
}

interface MessageFollowUpMessage {
  type: 'message.follow_up'
  payload: { sessionId: string; content: string }
}

// Sidecar → Client: Queue state updates
interface QueueUpdateEvent {
  type: 'queue.update'
  payload: {
    sessionId: string
    steering: string[]      // Messages in the steering queue
    followUp: string[]      // Messages in the follow-up queue
  }
}
```

**Frontend UX** (`ChatInput.vue` during generation):

```
┌──────────────────────────────────────────────────────────┐
│  [Agent is generating... typing below will queue]         │
├──────────────────────────────────────────────────────────┤
│  Actually, also check the error handling in auth.ts      │  ← User types during generation
├──────────────────────────────────────────────────────────┤
│  [↑ Follow-up: send after current] [↗ Steer: interrupt]  │  ← Two action buttons
└──────────────────────────────────────────────────────────┘
```

**Queue display** (in ChatView, above ChatInput during generation):

```vue
<!-- QueueIndicator.vue -->
<script setup lang="ts">
const chatStore = useChatStore()
const steerQueue = computed(() => chatStore.steerQueue)
const followUpQueue = computed(() => chatStore.followUpQueue)
</script>

<template>
  <div v-if="steerQueue.length || followUpQueue.length" class="px-4 py-2 text-sm text-text-muted border-t">
    <div v-if="steerQueue.length">
      <span class="text-warning">Steering:</span>
      {{ steerQueue.length }} message(s) queued
    </div>
    <div v-if="followUpQueue.length">
      <span class="text-accent">Follow-up:</span>
      {{ followUpQueue.length }} message(s) queued
    </div>
  </div>
</template>
```

**Sidecar integration**:

```typescript
// server.ts
async function handleMessageSteer(payload: { sessionId: string; content: string }) {
  const session = pool.get(payload.sessionId)
  if (!session) return

  // pi SDK call — injects a steering message into the current stream
  await session.prompt(payload.content, { streamingBehavior: 'steer' })
}

async function handleMessageFollowUp(payload: { sessionId: string; content: string }) {
  const session = pool.get(payload.sessionId)
  if (!session) return

  await session.prompt(payload.content, { streamingBehavior: 'followUp' })
}

// event-adapter.ts — forward queue_update events
case 'queue_update':
  sendToWs(ws, {
    type: 'queue.update',
    payload: {
      sessionId,
      steering: event.steering,
      followUp: event.followUp,
    },
  })
  break
```

**spec-v2 impact**: Section 5.2/5.3 (WS Protocol — add steer/followUp messages), Section 4.5 (ChatInput — add queue action buttons), arch-backend §2c (Event Conversion — add queue_update mapping)

---

### 2.3 Split Session Metadata/Data

**Source**: pi-mono session management, pi SDK `SessionInfo` vs full JSONL

**Problem**: When the frontend connects, it requests `session.list` which currently loads all session data (including full message histories) to build the sidebar. For users with many sessions, this is slow and memory-heavy. The sidebar only needs: ID, label, cwd, timestamp, status — not the full conversation content.

**Pattern**: Separate lightweight metadata (for sidebar listing) from full session data (for chat view). The metadata index is always in memory; full data is loaded on-demand when the user opens a session.

```
┌────────────────────────────────────┐
│ Metadata Index (always loaded)     │
│                                    │
│ Session 1: { id, label, cwd, ts } │  ← 100 bytes each
│ Session 2: { id, label, cwd, ts } │
│ Session 3: { id, label, cwd, ts } │
│ ... (50-200 sessions)             │
│ Total: ~20KB                       │
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ Full Session Data (on-demand)      │
│                                    │
│ Only loaded when user opens S1     │  ← 10-500KB per session
│ Contains: all messages, tool calls │
│ Loaded from JSONL file             │
└────────────────────────────────────┘
```

**Implementation — Metadata Index** (`sidecar/src/session-index.ts`):

```typescript
interface SessionMetadata {
  id: string
  cwd: string
  label: string           // name ?? firstMessage.slice(0, 80) ?? "New Session"
  lastActiveAt: number    // File modified time
  messageCount: number    // Entry count in JSONL (not full parse — just line count)
  status: 'active' | 'idle'
}

// Fast scan: read only file stats + first line of each JSONL
function buildMetadataIndex(sessionsDir: string): SessionMetadata[] {
  const files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'))
  return files.map(file => {
    const stat = statSync(file)
    const firstLine = readFirstLine(file)  // Only read 1 line, not the whole file
    return {
      id: parseSessionId(file),
      cwd: parseCwdFromPath(file),
      label: extractLabel(firstLine),
      lastActiveAt: stat.mtimeMs,
      messageCount: countLines(file),  // Fast line count (no JSON parse)
      status: pool.has(parseSessionId(file)) ? 'active' : 'idle',
    }
  })
}
```

**Protocol change** — `session.list` response stays the same shape (grouped by cwd) but only returns metadata:

```typescript
// No protocol change needed — SessionSummary already contains only metadata fields
interface SessionSummary {
  id: string
  label: string
  cwd: string
  lastActiveAt: number
  status: 'active' | 'idle'
  messageCount: number
}
```

The key change is **backend-side**: `session.list` handler uses `buildMetadataIndex()` instead of loading full JSONL files. This makes the sidebar load near-instant regardless of session count.

**Session history loading** — `session.switch` / `session.history` still loads the full JSONL and converts to `Message[]` as defined in arch-backend §6c. No change needed.

**Metadata caching**: Sidecar maintains an in-memory `Map<sessionId, SessionMetadata>` that updates when:
- Sessions are created / deleted
- `session_info_changed` event fires (label update)
- Periodic background scan (every 60s) to catch external changes (e.g., pi CLI creating sessions)

**spec-v2 impact**: arch-backend §6e (Session List Summary — use fast metadata scan), Section 5.3 (sidecar → client events — session.list implementation detail)

---

### 2.4 Slash Command Registry

**Source**: claude-code-source-code command system

**Problem**: The current `SlashMenu.vue` is described as "P1 先搭框架（空菜单）". This is fine for P1, but the framework should support easy command registration from day one. Without a registry pattern, every new command requires modifying SlashMenu.vue directly, leading to a monolithic switch/case.

**Pattern**: Registry where commands self-register with metadata (name, description, handler, group). SlashMenu renders from the registry. Commands can come from built-in definitions, composables, or future plugins.

```typescript
// composables/useSlashCommands.ts
interface SlashCommand {
  name: string              // e.g., "clear"
  description: string       // e.g., "Clear current conversation"
  group: string             // e.g., "session" | "agent" | "settings"
  handler: (args: string) => void | Promise<void>
  requiresConfirmation?: boolean  // e.g., /clear needs confirm
  visible?: () => boolean    // Conditional visibility
}

const commandRegistry = new Map<string, SlashCommand>()

export function registerSlashCommand(command: SlashCommand) {
  commandRegistry.set(command.name, command)
}

export function getSlashCommands(): SlashCommand[] {
  return [...commandRegistry.values()].filter(cmd => !cmd.visible || cmd.visible())
}

export function executeSlashCommand(name: string, args: string): void {
  const cmd = commandRegistry.get(name)
  if (!cmd) return
  cmd.handler(args)
}
```

**P1 built-in commands** (minimal set):

```typescript
// composables/useSlashCommands.ts — init
export function initBuiltinCommands() {
  registerSlashCommand({
    name: 'clear',
    description: 'Clear conversation history',
    group: 'session',
    handler: () => chatStore.clearMessages(),
    requiresConfirmation: true,
  })

  registerSlashCommand({
    name: 'compact',
    description: 'Compress conversation context',
    group: 'agent',
    handler: () => wsClient.send('session.compact', { sessionId }),
  })

  registerSlashCommand({
    name: 'model',
    description: 'Switch model',
    group: 'settings',
    handler: () => /* open ModelPicker */,
  })

  registerSlashCommand({
    name: 'help',
    description: 'Show available commands',
    group: 'general',
    handler: () => /* show command list */,
  })
}
```

**SlashMenu rendering**:

```vue
<!-- SlashMenu.vue -->
<script setup lang="ts">
import { getSlashCommands } from '@/composables/useSlashCommands'

const commands = computed(() => getSlashCommands())
const grouped = computed(() => {
  const groups = new Map<string, SlashCommand[]>()
  for (const cmd of commands.value) {
    const list = groups.get(cmd.group) ?? []
    list.push(cmd)
    groups.set(cmd.group, list)
  }
  return groups
})
</script>

<template>
  <div v-if="visible" class="slash-menu">
    <div v-for="[group, cmds] of grouped" :key="group" class="slash-group">
      <div class="slash-group__title">{{ group }}</div>
      <div
        v-for="cmd in cmds"
        :key="cmd.name"
        class="slash-item"
        @click="emit('select', cmd)"
      >
        <span class="font-mono">/{{ cmd.name }}</span>
        <span class="text-text-muted text-sm">{{ cmd.description }}</span>
      </div>
    </div>
  </div>
</template>
```

**spec-v2 impact**: Section 4.5 (SlashMenu — change from "empty" to "registry-driven"), arch-frontend §1 (Component Hierarchy — SlashMenu now renders from registry)

---

### 2.5 Context Window Management

**Source**: claude-code-source-code proactive compaction, pi SDK `compaction_start/end` events

**Problem**: As conversations grow, the context window fills up. Currently, the spec has no strategy for handling context overflow. The agent will eventually hit the token limit and fail with an error. The user sees a cryptic error toast and doesn't know what to do.

**Pattern**: Proactive compaction — monitor context usage and automatically compress the conversation when it approaches a threshold. The pi SDK already supports compaction events and the `session.compact` RPC command.

**Implementation layers**:

1. **Display**: ContextBar already shows usage percentage. Enhance it with explicit labels.
2. **Proactive trigger**: Sidecar monitors usage from `message.complete` events and triggers compaction when usage exceeds 80%.
3. **Manual trigger**: `/compact` command (via slash command registry, §2.4).
4. **Visual feedback**: Show compaction status in the chat view.

```
Context Usage States:

0-60%:  ████████░░░░  accent (normal)
60-80%: ███████████░  warning (approaching limit)
80%+:   █████████████ danger (compaction recommended)
95%+:   █████████████ danger + "Compacting..." overlay
```

**Sidecar proactive compaction** (`session-pool.ts`):

```typescript
// After each message.complete event, check context usage
function checkContextUsage(sessionId: string, usage: Usage) {
  const session = pool.get(sessionId)
  if (!session) return

  const contextLimit = session.model.contextWindow ?? 200_000
  const usagePercent = usage.totalTokens / contextLimit

  if (usagePercent > 0.85) {
    // Proactive compaction — trigger via pi RPC
    // pi SDK handles the compaction internally
    // Events: compaction_start → compaction_end
    logger.info(`Session ${sessionId} at ${Math.round(usagePercent * 100)}% context, triggering compaction`)
    // The compaction is handled by pi internally when threshold is reached
    // No explicit RPC call needed — pi auto-compacts on overflow
  }

  // Send usage update to frontend regardless
  sendToWs(ws, {
    type: 'context.update',
    payload: {
      sessionId,
      usagePercent: Math.round(usagePercent * 100),
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.totalTokens,
    },
  })
}
```

**Frontend compaction indicator**:

```vue
<!-- CompactionOverlay.vue — shown during compaction -->
<script setup lang="ts">
const chatStore = useChatStore()
const isCompacting = computed(() => chatStore.isCompacting)
</script>

<template>
  <div v-if="isCompacting" class="absolute inset-0 bg-surface/80 flex items-center justify-center z-10">
    <div class="text-center">
      <span class="text-accent animate-pulse">Compressing context…</span>
      <p class="text-sm text-text-muted mt-1">Summarizing conversation to free up space</p>
    </div>
  </div>
</template>
```

**Protocol additions**:

```typescript
// From pi SDK compaction events → WS events
// compaction_start → message.status { status: 'compacting' }
// compaction_end → message.status { status: 'compaction_done', tokensSaved: number }

// Manual trigger
interface SessionCompactMessage {
  type: 'session.compact'
  payload: { sessionId: string }
}
```

**spec-v2 impact**: Section 4.5 (ContextBar — enhance with compaction states), Section 5.3 (add compaction events to WS protocol), arch-backend §2c (add compaction event conversion)

---

## 3. P2 — Low Priority (Future-Proofing)

These optimizations prepare the architecture for future phases. Design the interfaces now, implement later.

### 3.1 Permission Model

**Source**: claude-code-source-code tiered permission system

**Pattern**: Each tool has a configurable permission level: `allow` (auto-execute), `ask` (require approval each time), `deny` (never execute). Users can configure per-tool permissions in settings.

```typescript
// types/permissions.ts
type PermissionLevel = 'allow' | 'ask' | 'deny'

interface ToolPermissions {
  [toolName: string]: PermissionLevel
}

// Default permissions:
const DEFAULT_PERMISSIONS: ToolPermissions = {
  read: 'allow',
  grep: 'allow',
  find: 'allow',
  ls: 'allow',
  bash: 'ask',       // Require approval by default
  edit: 'ask',       // Require approval by default
  write: 'ask',      // Require approval by default
}

// Config stored in ~/.xyz-agent/config.toml:
// [permissions]
// bash = "allow"
// write = "deny"
```

This builds on §2.1 Tool Approval Workflow — when a tool's permission is `ask`, the approval dialog is shown. When `allow`, tools execute immediately. When `deny`, the tool call is rejected before execution.

**spec-v2 impact**: Section 4.6 (Settings — add "Permissions" sub-section), arch-backend §3a (Config format — add `[permissions]` section)

---

### 3.2 Custom Message Types

**Source**: pi-mono UI-only message types

**Pattern**: Introduce UI-only message types that appear in the chat view but are never sent to the LLM. Used for:

- Status updates ("Compacting context…", "Retrying…", "Switched model to X")
- Dividers ("Session resumed from earlier conversation")
- Notifications ("Provider disconnected")
- System messages that aren't part of the conversation

```typescript
// types/message.ts — extended
type MessageType =
  | 'user'
  | 'assistant'
  | 'system'       // Existing: system prompt messages
  | 'status'       // NEW: UI-only status update
  | 'divider'      // NEW: Visual separator
  | 'notification' // NEW: UI-only notification

interface UIMessage {
  id: string
  type: MessageType
  content: string
  timestamp: number
  dismissible?: boolean    // For notifications
  variant?: 'info' | 'warning' | 'error' | 'success'
  isLLMVisible: boolean    // false for UI-only messages — never sent to pi
}
```

**Rendering**: `MessageList.vue` uses a switch on `message.type` to render the appropriate component:

```typescript
// MessageList.vue — rendering logic
const componentMap: Record<MessageType, Component> = {
  user: MessageBubble,
  assistant: MessageBubble,
  system: SystemMessage,
  status: StatusChip,
  divider: ConversationDivider,
  notification: NotificationBanner,
}
```

**spec-v2 impact**: Section 4.4 (Chat View — add UI-only message types table), arch-frontend §3a (Data Flow — add UI message insertion points)

---

### 3.3 Storage Backend Abstraction

**Source**: openhanako clean architecture, future cloud sync needs

**Pattern**: Define a storage interface so the backend can swap between JSONL files, SQLite, or cloud storage without changing business logic. This is relevant for P5+ when sessions may need to sync across devices.

```typescript
// sidecar/src/storage/interface.ts
interface SessionStorage {
  listMetadata(): Promise<SessionMetadata[]>
  loadHistory(sessionId: string): Promise<FrontendMessage[]>
  saveEntry(sessionId: string, entry: SessionEntry): Promise<void>
  delete(sessionId: string): Promise<void>
  exists(sessionId: string): Promise<boolean>
}

// P1 implementation: JSONL files (what pi SDK already does)
class JsonlSessionStorage implements SessionStorage { /* ... */ }

// Future: SQLite for faster queries
class SqliteSessionStorage implements SessionStorage { /* ... */ }

// Future: Cloud sync
class CloudSessionStorage implements SessionStorage { /* ... */ }
```

**P1 action**: Define the interface but only implement `JsonlSessionStorage`. Other implementations are future work.

**spec-v2 impact**: arch-backend — add storage interface section, note that P1 uses JSONL implementation only

---

### 3.4 Headless/Embeddable RPC Mode

**Source**: pi-mono extension communication, future VSCode/CLI embedding

**Pattern**: Expose the Sidecar's functionality via JSONL over stdin/stdout (same protocol as pi's RPC mode) instead of requiring a WebSocket connection. This allows embedding xyz-agent in:
- VSCode extension (spawn sidecar as child process, communicate via stdio)
- CLI mode (pipe commands in, read responses out)
- CI/CD pipelines
- Other Tauri apps

```typescript
// sidecar/src/index.ts — dual-mode entry
const mode = parseArg('--mode') ?? 'ws'  // 'ws' | 'stdio'

if (mode === 'ws') {
  // Normal mode: start WS server for Tauri frontend
  startWsServer(port)
} else if (mode === 'stdio') {
  // Headless mode: JSONL over stdin/stdout
  startStdioServer()
}

// sidecar/src/stdio-server.ts
function startStdioServer() {
  const rl = createInterface({ input: process.stdin })

  rl.on('line', (line) => {
    const msg = JSON.parse(line) as ClientMessage
    // Same handler routing as WS mode
    handleClientMessage(msg, {
      send: (response: ServerMessage) => {
        process.stdout.write(JSON.stringify(response) + '\n')
      },
    })
  })
}
```

**P1 action**: Design the interface so `server.ts` message routing is transport-agnostic. WS is the only transport in P1.

**spec-v2 impact**: arch-backend §6.4 (Sidecar lifecycle — note dual-mode entry point design)

---

## 4. spec-v2 Modification Map

For each optimization, this table specifies which sections of spec-v2 need updating and what changes to make.

### P0 Changes (implement during P1)

| Optimization | spec-v2 Section | Change |
|---|---|---|
| §1.1 Stable List + Streaming Split | §7.1 Store | Replace `messages: Message[]` with `completedMessages: Message[]` + `streamingMessage: StreamingAssistantMessage \| null`. Update all actions: `addMessage` → push to `completedMessages`; `appendDelta` → modify `streamingMessage.textContent`; add `finalizeStreamingMessage()` |
| §1.1 Stable List + Streaming Split | §4.4 Chat View | Update MessageList template to render `completedMessages` (static) + `streamingMessage` (reactive) as separate zones |
| §1.1 Stable List + Streaming Split | arch-frontend §3a | Update Send Message Flow diagram: show delta → `streamingMessage.textContent +=`, complete → `finalizeStreamingMessage()` → push to `completedMessages` |
| §1.1 Stable List + Streaming Split | arch-frontend §4.1 | Update `ChatState` interface: replace `messages` + `streamingText` with `completedMessages` + `streamingMessage` + `pendingToolCalls` |
| §1.2 rAF Batching | §7.1 Store | Update `appendDelta` action to use rAF buffer instead of immediate mutation. Add `deltaBuffer: string` and `rafId: number \| null` to internal state |
| §1.2 rAF Batching | arch-frontend §5.4 | Add note to ws-client architecture: "Streaming deltas are buffered per animation frame before store mutation" |
| §1.3 Tool Renderer Registry | §4.4 Chat View | Replace single `ToolCallCard.vue` description with registry pattern. Add `components/chat/tools/` directory with specialized renderers |
| §1.3 Tool Renderer Registry | arch-frontend §1 | Add `tools/` subdirectory under `chat/` with `GenericToolRenderer.vue`, `BashToolRenderer.vue`, etc. |
| §1.3 Tool Renderer Registry | arch-frontend §2 | Update component dependency: ToolCallCard now depends on dynamic component from registry, not inline rendering |
| §1.3 Tool Renderer Registry | §2 Project Structure | Add `components/chat/tools/` directory entries |

### P1 Changes (implement during P1 or early P2)

| Optimization | spec-v2 Section | Change |
|---|---|---|
| §2.1 Tool Approval | §5.2 WS Protocol | Add `message.tool_call_pending`, `tool.approve`, `tool.deny`, `tool.always_allow` message types to client→sidecar and sidecar→client tables |
| §2.1 Tool Approval | §4.4 Chat View | Add `ToolApprovalDialog.vue` component description. Update ToolCallCard to show pending state |
| §2.1 Tool Approval | arch-backend §4 | Add routing table entries for `tool.approve`, `tool.deny`, `tool.always_allow` |
| §2.2 Steering/Follow-up | §5.2 WS Protocol | Add `message.steer`, `message.follow_up` client→sidecar types |
| §2.2 Steering/Follow-up | §5.3 WS Protocol | Add `queue.update` sidecar→client event type |
| §2.2 Steering/Follow-up | §4.5 Chat Input | Add queue action buttons (Follow-up / Steer) that appear during generation |
| §2.2 Steering/Follow-up | arch-backend §2c | Add `queue_update` → `queue.update` event conversion entry |
| §2.3 Session Metadata | arch-backend §6e | Update `session.list` to use fast metadata scan instead of full JSONL loading |
| §2.3 Session Metadata | §5.4 Session List | Note that `session.list` returns metadata only, full data loaded on `session.switch` |
| §2.4 Slash Commands | §4.5 SlashMenu | Change from "P1 空菜单" to "registry-driven with /clear, /compact, /help, /model" |
| §2.4 Slash Commands | §2 Project Structure | Add `composables/useSlashCommands.ts` |
| §2.5 Context Management | §4.5 ContextBar | Enhance with compaction states (60% warning, 80% danger, 95% auto-compact) |
| §2.5 Context Management | §5.3 WS Protocol | Add `context.update` and `session.compact` message types |
| §2.5 Context Management | arch-backend §2c | Add `compaction_start/end` → `message.status` conversion |

### P2 Changes (design interfaces only, implement later)

| Optimization | spec-v2 Section | Change |
|---|---|---|
| §3.1 Permission Model | §4.6 Settings | Add "Permissions" sub-section to Settings layout (P2+ marker) |
| §3.1 Permission Model | arch-backend §3a | Add `[permissions]` section to `config.toml` format |
| §3.2 Custom Message Types | §4.4 Chat View | Add `status`, `divider`, `notification` to message type table |
| §3.3 Storage Abstraction | arch-backend new § | Add storage interface definition, note P1 uses JSONL only |
| §3.4 Headless RPC | arch-backend §6.1 | Add dual-mode entry point design (`--mode ws\|stdio`) |

---

## Appendix: Optimization Dependency Graph

```
§1.1 Stable List Split ←── prerequisite for §1.2 rAF Batching
                     ←── enables §2.2 Steering UX (streaming container is where steer indicator lives)

§1.3 Tool Renderer Registry ←── enables §2.1 Tool Approval (approval dialog is a renderer variant)

§2.1 Tool Approval ←── uses §3.1 Permission Model for allow/ask/deny decisions

§2.4 Slash Commands ←── provides /compact command for §2.5 Context Management

§2.5 Context Management ←── uses pi SDK compaction events
                        ←── §2.3 Session Metadata enables fast usage aggregation

§3.3 Storage Abstraction ←── §2.3 Session Metadata is the first step (split data vs metadata)
§3.4 Headless RPC ←── independent, can be implemented any time
```

**Recommended implementation order for P1**:

```
Week 1: §1.1 Stable List Split (foundational — affects all streaming)
Week 1: §1.2 rAF Batching (small change, big perf win, depends on §1.1)
Week 2: §1.3 Tool Renderer Registry (affects how tools are displayed)
Week 2: §2.4 Slash Commands (small scope, useful immediately)
Week 3: §2.5 Context Management (uses slash commands + pi SDK events)
Week 3: §2.3 Session Metadata (backend optimization, no frontend change)
Week 4: §2.1 Tool Approval (safety feature, needs UI + protocol changes)
Week 4: §2.2 Steering/Follow-up (UX feature, needs pi SDK integration)
```
