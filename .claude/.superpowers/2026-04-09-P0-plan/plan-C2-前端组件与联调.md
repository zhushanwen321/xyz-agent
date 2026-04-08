# 前端组件与联调 — 实施计划

> 前置条件：Task 1-7（后端）已完成，Task 8（前端脚手架+类型）已完成。
>
> - `src/types/index.ts` 中有 `AgentEvent`, `ChatMessage`, `SessionInfo`, `TranscriptEntry` 类型
> - `src/lib/tauri.ts` 中有 `createSession`, `listSessions`, `getHistory`, `sendMessage`, `onAgentEvent` 函数
> - shadcn-vue 组件已安装：Button, Textarea, ScrollArea, Separator

---

## Task 9: 前端组件 + Composables

### 9.1 创建 useSession composable

- [ ] 创建 `src/composables/useSession.ts`

```typescript
import { ref } from 'vue'
import { createSession, listSessions } from '../lib/tauri'
import type { SessionInfo } from '../types'

const sessions = ref<SessionInfo[]>([])
const currentSessionId = ref<string | null>(null)

export function useSession() {
  async function loadSessions() {
    sessions.value = await listSessions('/')
  }

  async function selectSession(id: string) {
    currentSessionId.value = id
  }

  async function createNewSession() {
    const result = await createSession('/')
    await loadSessions()
    currentSessionId.value = result.session_id
  }

  return { sessions, currentSessionId, loadSessions, selectSession, createNewSession }
}
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.2 创建 useChat composable

- [ ] 创建 `src/composables/useChat.ts`

```typescript
import { ref, onMounted, onUnmounted, watch, type Ref } from 'vue'
import { sendMessage, getHistory, onAgentEvent } from '../lib/tauri'
import type { AgentEvent, ChatMessage, TranscriptEntry } from '../types'

export function useChat(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([])
  const streamingText = ref('')
  const isStreaming = ref(false)
  let unlisten: (() => void) | null = null

  onMounted(async () => {
    unlisten = await onAgentEvent((event: AgentEvent) => {
      if (!sessionId.value || event.session_id !== sessionId.value) return

      switch (event.type) {
        case 'TextDelta':
          streamingText.value += event.delta
          break
        case 'MessageComplete':
          messages.value.push({
            id: crypto.randomUUID(),
            role: event.role as 'assistant',
            content: event.content,
            timestamp: new Date().toISOString(),
          })
          streamingText.value = ''
          isStreaming.value = false
          break
        case 'Error':
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'system',
            content: `Error: ${event.message}`,
            timestamp: new Date().toISOString(),
          })
          isStreaming.value = false
          break
      }
    })
  })

  onUnmounted(() => {
    unlisten?.()
  })

  async function send(content: string) {
    if (!sessionId.value || isStreaming.value) return
    isStreaming.value = true
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    })
    streamingText.value = ''
    await sendMessage(sessionId.value, content)
  }

  async function loadHistory(sid: string) {
    const entries: TranscriptEntry[] = await getHistory(sid)
    messages.value = entries
      .filter((e) => e.type === 'user' || e.type === 'assistant')
      .map((e) => ({
        id: e.uuid,
        role: e.type as 'user' | 'assistant',
        content: e.content,
        timestamp: e.timestamp,
      }))
  }

  watch(sessionId, (newId) => {
    if (newId) loadHistory(newId)
  })

  return { messages, streamingText, isStreaming, send }
}
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.3 创建 Sidebar.vue

- [ ] 创建 `src/components/Sidebar.vue`

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import { useSession } from '../composables/useSession'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

const { sessions, currentSessionId, loadSessions, selectSession, createNewSession } = useSession()

onMounted(() => {
  loadSessions()
})
</script>

<template>
  <div class="flex h-full w-[250px] flex-col border-r bg-muted/30">
    <!-- 标题 -->
    <div class="px-4 py-3">
      <h1 class="text-lg font-semibold">xyz-agent</h1>
    </div>

    <Separator />

    <!-- Session 列表 -->
    <ScrollArea class="flex-1 px-2 py-2">
      <Button
        v-for="session in sessions"
        :key="session.id"
        variant="ghost"
        class="mb-1 w-full justify-start text-left"
        :class="{ 'bg-accent': currentSessionId === session.id }"
        @click="selectSession(session.id)"
      >
        <span class="truncate">{{ session.title }}</span>
      </Button>

      <div v-if="sessions.length === 0" class="px-2 py-8 text-center text-sm text-muted-foreground">
        暂无会话
      </div>
    </ScrollArea>

    <Separator />

    <!-- 新建对话 -->
    <div class="p-2">
      <Button class="w-full" @click="createNewSession">
        新建对话
      </Button>
    </div>
  </div>
</template>
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.4 创建 MessageBubble.vue

- [ ] 先安装 markdown-it 依赖

```bash
npm install markdown-it
npm install -D @types/markdown-it
```

- [ ] 创建 `src/components/MessageBubble.vue`

```vue
<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import type { ChatMessage } from '../types'

const props = defineProps<{
  message: ChatMessage
  streamingText?: string
}>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')

const renderedContent = computed(() => {
  let text = props.message.content
  if (props.streamingText) {
    text += props.streamingText
  }
  return md.render(text)
})
</script>

<template>
  <div
    class="flex"
    :class="{
      'justify-end': isUser,
      'justify-start': !isUser,
    }"
  >
    <div
      class="max-w-[80%] rounded-lg px-4 py-2.5"
      :class="{
        'bg-primary text-primary-foreground': isUser,
        'bg-muted': !isUser && !isSystem,
        'bg-destructive/10 text-destructive': isSystem,
      }"
    >
      <!-- 角色 label -->
      <div class="mb-1 text-xs font-medium opacity-60">
        {{ isUser ? 'You' : isSystem ? 'System' : 'Assistant' }}
      </div>

      <!-- Markdown 渲染 -->
      <div
        class="prose prose-sm max-w-none dark:prose-invert"
        v-html="renderedContent"
      />

      <!-- 流式光标 -->
      <span
        v-if="streamingText"
        class="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current"
      />
    </div>
  </div>
</template>
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.5 创建 MessageInput.vue

- [ ] 创建 `src/components/MessageInput.vue`

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

defineProps<{
  isStreaming: boolean
}>()

const emit = defineEmits<{
  send: [content: string]
}>()

const inputText = ref('')

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function handleSend() {
  const trimmed = inputText.value.trim()
  if (!trimmed) return
  emit('send', trimmed)
  inputText.value = ''
}
</script>

<template>
  <div class="flex items-end gap-2 border-t bg-background px-4 py-3">
    <Textarea
      v-model="inputText"
      :disabled="isStreaming"
      placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
      class="min-h-[60px] max-h-[200px] resize-none"
      rows="2"
      @keydown="handleKeydown"
    />
    <Button
      :disabled="isStreaming || !inputText.trim()"
      size="icon"
      class="h-10 w-10 shrink-0"
      @click="handleSend"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    </Button>
  </div>
</template>
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.6 创建 StatusBar.vue

- [ ] 创建 `src/components/StatusBar.vue`

```vue
<script setup lang="ts">
defineProps<{
  isStreaming: boolean
  modelName: string
}>()
</script>

<template>
  <div class="flex items-center justify-between border-t bg-muted/30 px-4 py-1 text-xs text-muted-foreground">
    <span>{{ modelName }}</span>
    <span v-if="isStreaming" class="flex items-center gap-1">
      <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
      生成中...
    </span>
    <span v-else>就绪</span>
  </div>
</template>
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.7 创建 ChatView.vue

- [ ] 创建 `src/components/ChatView.vue`

```vue
<script setup lang="ts">
import { ref, watch, nextTick, computed, type Ref } from 'vue'
import { useChat } from '../composables/useChat'
import { ScrollArea } from '@/components/ui/scroll-area'
import MessageBubble from './MessageBubble.vue'
import MessageInput from './MessageInput.vue'

const props = defineProps<{
  currentSessionId: string | null
}>()

const sessionIdRef = computed(() => props.currentSessionId) as Ref<string | null>
const { messages, streamingText, isStreaming, send } = useChat(sessionIdRef)

const scrollContainer = ref<HTMLDivElement | null>(null)

// 消息变化或流式文本变化时，自动滚动到底部
watch(
  [() => messages.value.length, streamingText],
  async () => {
    await nextTick()
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  },
)

// 判断最后一条 assistant 消息是否正在流式输出
const isLastAssistantStreaming = computed(() => {
  if (!streamingText.value) return false
  const last = messages.value[messages.value.length - 1]
  return last?.role === 'assistant'
})

function handleSend(content: string) {
  send(content)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 消息列表 -->
    <div ref="scrollContainer" class="flex-1 overflow-y-auto px-4 py-4">
      <div v-if="messages.length === 0" class="flex h-full items-center justify-center text-muted-foreground">
        <p>开始一段新对话</p>
      </div>

      <div class="mx-auto max-w-3xl space-y-4">
        <MessageBubble
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
        />

        <!-- 流式输出占位：当没有 assistant 消息但 streamingText 有内容时 -->
        <MessageBubble
          v-if="streamingText && !isLastAssistantStreaming"
          :message="{
            id: 'streaming',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }"
          :streaming-text="streamingText"
        />
      </div>
    </div>

    <!-- 输入区 -->
    <MessageInput
      :is-streaming="isStreaming"
      @send="handleSend"
    />
  </div>
</template>
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.8 更新 App.vue

- [ ] 重写 `src/App.vue`

```vue
<script setup lang="ts">
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import StatusBar from './components/StatusBar.vue'
import { useSession } from './composables/useSession'

const { currentSessionId } = useSession()
</script>

<template>
  <div class="flex h-screen flex-col bg-background text-foreground">
    <div class="flex flex-1 overflow-hidden">
      <!-- 侧边栏 -->
      <Sidebar />

      <!-- 主内容区 -->
      <ChatView :current-session-id="currentSessionId" />
    </div>

    <!-- 状态栏 -->
    <StatusBar
      :is-streaming="false"
      model-name="claude-sonnet-4-5"
    />
  </div>
</template>
```

注意：`StatusBar` 的 `isStreaming` 这里硬编码为 false，因为 App 层不直接持有 streaming 状态。后续重构时可以提升到 App 层或通过 provide/inject 传递。当前 P0 阶段先保持简单。

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：无类型错误
```

---

### 9.9 验证前端编译

- [ ] 运行构建

```bash
npm run build
```

**期望输出**：

```
vite v6.x.x building for production...
✓ xx modules transformed.
dist/index.html                   0.xx kB │ gzip:  0.xx kB
dist/assets/index-xxxxxxxx.css    xx.xx kB │ gzip:  xx.xx kB
dist/assets/index-xxxxxxxx.js     xx.xx kB │ gzip:  xx.xx kB
✓ built in xxxms
```

---

### 9.10 Commit

- [ ] 提交前端组件

```bash
git add src/
git commit -m "feat(frontend): add Vue components and composables

- useSession: session list management
- useChat: message handling with Tauri event streaming
- Sidebar, ChatView, MessageBubble, MessageInput, StatusBar components
- Full layout with shadcn-vue and Tailwind CSS"
```

---

## Task 10: 端到端联调

### 10.1 启动 Tauri dev 模式

- [ ] 确保环境变量已设置

```bash
export ANTHROPIC_API_KEY="sk-ant-xxx"
```

- [ ] 启动开发服务器

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent
npm run tauri dev
```

**期望**：Tauri 窗口打开，显示侧边栏（"xyz-agent" 标题 + "暂无会话"）和主内容区（"开始一段新对话"）。

如果编译失败，检查以下常见问题：
- `src/types/index.ts` 中的类型是否与 `useChat` 引用的匹配
- `src/lib/tauri.ts` 中的函数签名是否与 composable 调用一致
- shadcn-vue 组件的 import 路径是否正确（取决于 `components.json` 配置）

---

### 10.2 测试基本流程

- [ ] 测试步骤 1：新建会话

操作：点击"新建对话"按钮
期望：侧边栏出现一个新的 session 条目（标题 "New Session"），主内容区清空显示"开始一段新对话"。

- [ ] 测试步骤 2：发送消息

操作：在输入框输入"你好"，按 Enter
期望：
1. 用户消息气泡出现在右侧（蓝色背景）
2. 助手消息逐字流式出现在左侧（灰色背景）
3. 流式输出过程中，输入框和发送按钮禁用
4. 流式完成后，输入框恢复可用

- [ ] 测试步骤 3：切换 session

操作：再次点击"新建对话"，输入另一条消息，然后点击侧边栏中第一个 session
期望：第一个 session 的历史消息被加载显示。

- [ ] 测试步骤 4：切换回来

操作：点击第二个 session
期望：第二个 session 的消息正常显示。

---

### 10.3 测试错误处理

- [ ] 测试 API Key 缺失

操作：不设置 `ANTHROPIC_API_KEY` 环境变量，启动 `npm run tauri dev`
期望：应用启动时 panic 或在控制台显示 "ANTHROPIC_API_KEY not found" 错误。

- [ ] 测试错误 API Key

操作：设置无效的 API key，发送消息
期望：消息气泡中显示错误信息（红色背景），例如 "Error: API error 401: ..."

---

### 10.4 修复发现的问题

根据 10.2-10.3 测试结果，常见需要修复的问题：

1. **类型不匹配**：Rust 端 `serde_json::Value` 返回的字段名与 TypeScript 类型定义不一致
   - 检查 `AgentEvent` 的 `type` 字段序列化是否匹配（TextDelta vs text_delta）
   - 检查 `TranscriptEntry` 的 JSON 字段名

2. **事件过滤**：`onAgentEvent` 回调中 `session_id` 过滤逻辑
   - 确认 Rust 端 emit 的 payload 结构与前端解析一致

3. **自动滚动**：消息列表自动滚动到底部的行为
   - 检查 `scrollContainer` ref 绑定是否在正确的 DOM 元素上
   - 确认 `nextTick` 时序是否正确

4. **Session 列表刷新**：创建新 session 后侧边栏是否更新
   - 确认 `createNewSession` 调用了 `loadSessions`
   - 确认 `listSessions` 返回的数据格式正确

---

### 10.5 最终 Commit

- [ ] 提交修复

```bash
git add -A
git commit -m "fix: address e2e testing issues

- Fix any type mismatches between Rust and TypeScript
- Fix event filtering by session_id
- Fix auto-scroll behavior"
```

---

## 完成检查清单

- [ ] `npm run build` 无错误
- [ ] `npm run tauri dev` 能正常启动
- [ ] 新建会话 -> 发送消息 -> 流式输出正常
- [ ] 切换 session -> 历史消息加载正常
- [ ] 错误 API Key 时有明确错误提示
- [ ] Task 9 和 Task 10 各有独立 commit
- [ ] 所有组件使用 shadcn-vue + Tailwind CSS
- [ ] useChat 正确处理 TextDelta / MessageComplete / Error 三种事件
- [ ] 流式输出期间输入框禁用
