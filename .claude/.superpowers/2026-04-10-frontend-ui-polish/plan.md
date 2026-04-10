# 前端 UI 优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化前端 UI：统一消息视觉样式、合并工具调用到 Assistant 轮次、添加 Topbar 导航和设置页面、调整窗口大小

**Architecture:** 前端引入 AssistantSegment 数据模型实现文本/工具交错渲染；App 层新增 Topbar + 条件路由（Chat/Settings）；后端新增 config 读写 API，使用 toml_edit crate

**Tech Stack:** Vue 3 Composition API, Tailwind CSS v4, Tauri v2, Rust, toml_edit crate

**Spec:** `.claude/.superpowers/specs/2026-04-10-frontend-ui-polish-design.md`

---

## Task 1: 后端 — 窗口大小动态设置

**Files:**
- Modify: `src-tauri/tauri.conf.json:13-20`
- Modify: `src-tauri/src/lib.rs:47-59`

- [ ] **Step 1: 更新 tauri.conf.json 默认窗口尺寸**

将 `width` 改为 1200，`height` 改为 800（确保启动时有可见窗口，动态设置会覆盖）。

- [ ] **Step 2: 在 lib.rs setup 中动态设置 75% 屏幕尺寸**

在 `tauri::Builder::default().setup(move |app| { ... })` 回调内，在 `app.manage(...)` 之前，添加。注意需要额外的 import：

```rust
use tauri::PhysicalSize;
```

```rust
// 动态设置窗口大小为屏幕 75%
if let Some(window) = app.get_webview_window("main") {
    if let Some(monitor) = window.primary_monitor().ok().flatten() {
        let size = monitor.size();
        let w = (size.width as f64 * 0.75) as u32;
        let h = (size.height as f64 * 0.75) as u32;
        let _ = window.set_size(tauri::PhysicalSize::new(w, h));
        let _ = window.center();
    }
}
```

- [ ] **Step 3: 验证构建通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无错误

- [ ] **Step 4: Commit**

```
feat: 窗口启动时动态设置为屏幕 75%
```

---

## Task 2: 后端 — config 读写 API

**Files:**
- Modify: `src-tauri/Cargo.toml:27` (添加 toml_edit 依赖)
- Modify: `src-tauri/src/engine/config/mod.rs`
- Modify: `src-tauri/src/api/commands.rs`
- Modify: `src-tauri/src/api/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 添加 toml_edit 依赖**

在 `Cargo.toml` 的 `[dependencies]` 中添加：

```toml
toml_edit = "0.22"
```

- [ ] **Step 2: 扩展 LlmConfig 加载逻辑**

在 `src-tauri/src/engine/config/mod.rs` 中添加通用辅助函数（替换 `read_api_key_from_config_file`）：

```rust
/// 从 config.toml 读取指定 key 的值（剥离引号）
fn read_config_value(key: &str) -> Result<String, ()> {
    let config_path = dirs::home_dir()
        .ok_or(())?
        .join(".xyz-agent")
        .join("config.toml");
    if !config_path.exists() { return Err(()); }
    let content = std::fs::read_to_string(&config_path).map_err(|_| ())?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(key) {
            let rest = rest.trim_start_matches(['=', ' ']).trim();
            if !rest.is_empty() { return Ok(rest.to_string()); }
        }
    }
    Err(())
}
```

修改 `load_llm_config()`，`base_url` 和 `model` 先从环境变量读取，fallback 到 config.toml：

```rust
let api_key = std::env::var("ANTHROPIC_API_KEY")
    .or_else(|_| read_config_value("anthropic_api_key"))
    .map_err(|_| AppError::Config("ANTHROPIC_API_KEY not found".to_string()))?;

let base_url = std::env::var("ANTHROPIC_BASE_URL")
    .or_else(|_| read_config_value("anthropic_base_url"))
    .unwrap_or_else(|_| "https://api.anthropic.com".to_string());

let model = std::env::var("LLM_MODEL")
    .or_else(|_| read_config_value("llm_model"))
    .unwrap_or_else(|_| "claude-sonnet-4-20250514".to_string());
```

删除原有的 `read_api_key_from_config_file` 函数。

- [ ] **Step 3: 实现 save_config 函数**

在 `src-tauri/src/engine/config/mod.rs` 中新增：

```rust
use toml_edit::{DocumentMut, Item};

pub fn save_config(
    llm_api_key: &str,
    llm_model: &str,
    llm_base_url: &str,
    max_turns: u32,
    context_window: u32,
    max_output_tokens: u32,
    tool_output_max_bytes: usize,
    bash_default_timeout_secs: u64,
) -> Result<(), AppError> {
    let config_path = dirs::home_dir()
        .ok_or(AppError::Config("no home dir".into()))?
        .join(".xyz-agent")
        .join("config.toml");

    let doc = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| AppError::Config(format!("failed to read: {e}")))?;
        content.parse::<DocumentMut>()
            .map_err(|e| AppError::Config(format!("failed to parse TOML: {e}")))?
    } else {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Config(format!("failed to create dir: {e}")))?;
        }
        DocumentMut::new()
    };

    // Agent 配置（从前端传入的值写入）
    doc["max_turns"] = Item::Value(toml_edit::value(max_turns as i64));
    doc["context_window"] = Item::Value(toml_edit::value(context_window as i64));
    doc["max_output_tokens"] = Item::Value(toml_edit::value(max_output_tokens as i64));
    doc["tool_output_max_bytes"] = Item::Value(toml_edit::value(tool_output_max_bytes as i64));
    doc["bash_default_timeout_secs"] = Item::Value(toml_edit::value(bash_default_timeout_secs as i64));

    // LLM 配置
    doc["anthropic_api_key"] = Item::Value(toml_edit::value(llm_api_key));
    doc["llm_model"] = Item::Value(toml_edit::value(llm_model));
    doc["anthropic_base_url"] = Item::Value(toml_edit::value(llm_base_url));

    std::fs::write(&config_path, doc.to_string())
        .map_err(|e| AppError::Config(format!("failed to write config: {e}")))?;

    Ok(())
}
```

- [ ] **Step 4: 实现 get_config / update_config commands**

在 `src-tauri/src/api/commands.rs` 新增：

```rust
#[derive(serde::Serialize)]
pub struct ConfigResponse {
    // LLM
    pub anthropic_api_key: String,
    pub llm_model: String,
    pub anthropic_base_url: String,
    // Agent
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
}

#[derive(serde::Deserialize)]
pub struct UpdateConfigRequest {
    pub anthropic_api_key: String,
    pub llm_model: String,
    pub anthropic_base_url: String,
    pub max_turns: u32,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub tool_output_max_bytes: usize,
    pub bash_default_timeout_secs: u64,
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<ConfigResponse, String> {
    let agent = &state.config;
    let llm = crate::engine::config::load_llm_config().map_err(|e| e.to_string())?;
    Ok(ConfigResponse {
        anthropic_api_key: llm.api_key,
        llm_model: llm.model,
        anthropic_base_url: llm.base_url,
        max_turns: agent.max_turns,
        context_window: agent.context_window,
        max_output_tokens: agent.max_output_tokens,
        tool_output_max_bytes: agent.tool_output_max_bytes,
        bash_default_timeout_secs: agent.bash_default_timeout_secs,
    })
}

#[tauri::command]
pub async fn update_config(
    payload: UpdateConfigRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::engine::config::save_config(
        &payload.anthropic_api_key,
        &payload.llm_model,
        &payload.anthropic_base_url,
        payload.max_turns,
        payload.context_window,
        payload.max_output_tokens,
        payload.tool_output_max_bytes,
        payload.bash_default_timeout_secs,
    )
    .map_err(|e| e.to_string())
}
```

- [ ] **Step 5: 注册新 commands**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中添加 `get_config` 和 `update_config`。

- [ ] **Step 6: 添加测试**

在 `config/mod.rs` 的 tests 模块中添加 `save_config` 的测试：写入后读取验证值一致。

- [ ] **Step 7: 验证构建和测试**

Run: `cd src-tauri && cargo test`
Expected: 全部通过

- [ ] **Step 8: Commit**

```
feat: config 读写 API — get_config / update_config + toml_edit
```

---

## Task 3: 前端 — 类型定义更新

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 添加 AssistantSegment 类型，更新 ChatMessage**

在 `src/types/index.ts` 中：

```typescript
/** Assistant 消息内的有序片段 */
export type AssistantSegment =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCallDisplay }

// 前端内部使用的消息模型
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string                // user/system 消息使用
  segments?: AssistantSegment[]  // assistant 消息使用（替代 toolCalls）
  timestamp: string
  isStreaming?: boolean
  // toolCalls 已废弃，保留类型兼容但不再使用
  toolCalls?: ToolCallDisplay[]
}

/** 工具危险等级 */
export type ToolDangerLevel = 'safe' | 'caution'

/** 工具危险等级映射 */
export const TOOL_DANGER_LEVEL: Record<string, ToolDangerLevel> = {
  Read: 'safe',
  Bash: 'caution',
  Write: 'caution',
}

export function getToolDangerLevel(toolName: string): ToolDangerLevel {
  return TOOL_DANGER_LEVEL[toolName] ?? 'caution'
}
```

- [ ] **Step 2: 验证前端构建**

Run: `npm run build`
Expected: 类型检查通过

- [ ] **Step 3: Commit**

```
feat: AssistantSegment 类型 + 工具危险等级映射
```

---

## Task 5: 前端 — MessageBubble + ChatView 视觉重构

**Files:**
- Modify: `src/components/MessageBubble.vue`
- Modify: `src/components/ChatView.vue`

- [ ] **Step 1: 重写 MessageBubble.vue**

根据 spec 的视觉规范重写模板：

- User 消息：右对齐，标题行 `→ User`，卡片背景 `bg-bg-elevated`，左侧 3px 灰色色条
- Assistant 消息：左对齐，标题行 `λ Assistant`（λ 带绿色背景标签），遍历 `segments` 渲染
  - text segment → 左对齐卡片 + 3px 绿色色条
  - tool segment → 渲染 ToolCallCard（不再单独的 toolCalls 数组）
- System 消息：保持现有红色样式不变
- 新增 `isStreaming` prop：为 true 时在最后一个 text segment 后显示闪烁光标

Assistant 消息不再使用 `streamingText` prop，改为通过 `segments` + `isStreaming` 渲染流式内容。

- [ ] **Step 2: 修改 ChatView.vue 适配新数据模型**

关键变更：
1. 从 `useChat` 解构 `currentTurnSegments`
2. 移除 `streamingText` 的使用（不再传递给 MessageBubble）
3. 移除独立的流式 MessageBubble（第 69-79 行）
4. 流式内容通过最后一条 assistant 消息的 segments 渲染

```vue
<script setup lang="ts">
// ... 现有 imports 不变 ...
const { messages, isStreaming, tokenUsage, send, currentTurnSegments } = useChat(sessionIdRef)

// 流式时合并 currentTurnSegments 到最后一条 assistant 消息
const displayMessages = computed(() => {
  const msgs = [...messages.value]
  if (isStreaming.value && currentTurnSegments.value.length > 0) {
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        segments: [...(last.segments ?? []), ...currentTurnSegments.value],
      }
    } else {
      msgs.push({
        id: `streaming-${Date.now()}`,
        role: 'assistant',
        content: '',
        segments: [...currentTurnSegments.value],
        timestamp: new Date().toISOString(),
        isStreaming: true,
      })
    }
  }
  return msgs
})
</script>

<template>
  <div class="flex h-full flex-1 flex-col bg-bg-surface">
    <div ref="scrollContainer" class="flex-1 overflow-y-auto px-4 py-6">
      <EmptyState v-if="messages.length === 0" />
      <div v-else class="mx-auto max-w-[720px] space-y-6">
        <MessageBubble
          v-for="msg in displayMessages"
          :key="msg.id"
          :message="msg"
          :is-streaming="msg.isStreaming"
        />
      </div>
    </div>
    <MessageInput :is-streaming="isStreaming" @send="handleSend" />
    <StatusBar
      :is-streaming="isStreaming"
      :model-name="modelName"
      :input-tokens="tokenUsage.inputTokens"
      :output-tokens="tokenUsage.outputTokens"
      :tool-count="toolCount"
    />
  </div>
</template>
```

- [ ] **Step 3: 验证前端构建**

---

## Task 4: 前端 — useChat 数据模型重构

**Files:**
- Modify: `src/composables/useChat.ts`

这是最核心的改动，需要重构事件处理逻辑。

- [ ] **Step 1: 重构 useChat 事件处理**

关键变更：
1. 引入 `currentTurnSegments: ref<AssistantSegment[]>([])`
2. `TextDelta` → 追加到最后一个 text segment 或创建新的
3. `ToolCallStart` → push tool segment 到 currentTurnSegments
4. `MessageComplete` → 不再创建新消息，改为追加 text segment
5. `TurnComplete` → 将 currentTurnSegments 封装为 ChatMessage push 到 messages
6. `ToolCallEnd` → 在 currentTurnSegments 中找到对应 tool segment 更新状态

```typescript
import type {
  AgentEvent,
  AssistantSegment,
  ChatMessage,
  ToolCallDisplay,
  UserContentBlock,
  AssistantContentBlock,
} from '../types'

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString() }
}

export function useChat(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([])
  const streamingText = ref('')
  const isStreaming = ref(false)
  const tokenUsage = ref({ inputTokens: 0, outputTokens: 0 })
  const currentTurnSegments = ref<AssistantSegment[]>([])
  let unlisten: (() => void) | null = null

  function appendTextToCurrentTurn(text: string) {
    const segs = currentTurnSegments.value
    if (segs.length > 0 && segs[segs.length - 1].type === 'text') {
      ;(segs[segs.length - 1] as { type: 'text'; text: string }).text += text
    } else {
      segs.push({ type: 'text', text })
    }
  }

  function findToolSegment(tool_use_id: string): { type: 'tool'; call: ToolCallDisplay } | undefined {
    return currentTurnSegments.value.find(
      (s): s is { type: 'tool'; call: ToolCallDisplay } =>
        s.type === 'tool' && s.call.tool_use_id === tool_use_id,
    )?.call
  }

  onMounted(async () => {
    if (!isTauri()) return
    unlisten = await onAgentEvent((event: AgentEvent) => {
      if (!sessionId.value || event.session_id !== sessionId.value) return

      switch (event.type) {
        case 'TextDelta':
          streamingText.value += event.delta
          appendTextToCurrentTurn(event.delta)
          break
        case 'ThinkingDelta':
          break
        case 'MessageComplete': {
          // TextDelta 已逐字追加到 currentTurnSegments，
          // 这里只清空 streamingText 并更新 tokenUsage
          streamingText.value = ''
          tokenUsage.value = {
            inputTokens: event.usage.input_tokens,
            outputTokens: tokenUsage.value.outputTokens + event.usage.output_tokens,
          }
          break
        }
        case 'TurnComplete': {
          // 将 currentTurnSegments 封装为 ChatMessage
          if (currentTurnSegments.value.length > 0) {
            messages.value.push({
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '',  // segments 替代 content
              segments: [...currentTurnSegments.value],
              timestamp: new Date().toISOString(),
            })
            currentTurnSegments.value = []
          }
          isStreaming.value = false
          break
        }
        case 'Error':
          messages.value.push(createMessage('system', `Error: ${event.message}`))
          isStreaming.value = false
          break
        case 'ToolCallStart': {
          currentTurnSegments.value.push({
            type: 'tool',
            call: {
              tool_use_id: event.tool_use_id,
              tool_name: event.tool_name,
              input: event.input,
              status: 'running',
            },
          })
          break
        }
        case 'ToolCallEnd': {
          const tc = findToolSegment(event.tool_use_id)
          if (tc) {
            tc.status = event.is_error ? 'error' : 'completed'
            tc.output = event.output
          }
          break
        }
      }
    })
  })

  onUnmounted(() => { unlisten?.() })

  async function send(content: string) {
    if (!sessionId.value || isStreaming.value) return
    isStreaming.value = true
    messages.value.push(createMessage('user', content))
    currentTurnSegments.value = []
    streamingText.value = ''
    try {
      await sendMessage(sessionId.value, content)
    } catch (err) {
      messages.value.push(createMessage('system', `发送失败: ${err}`))
      isStreaming.value = false
    }
  }

  async function loadHistory(sid: string) {
    const result = await getHistory(sid)
    const msgs: ChatMessage[] = []

    // 预扫描：建立 tool_use_id → { output, is_error } 映射
    const toolOutputs = new Map<string, { output: string; is_error: boolean }>()
    for (const entry of result.entries) {
      if (entry.type === 'user') {
        for (const block of entry.content as UserContentBlock[]) {
          if (block.type === 'tool_result') {
            toolOutputs.set(block.tool_use_id, {
              output: block.content,
              is_error: block.is_error,
            })
          }
        }
      }
    }

    if (result.conversation_summary) {
      msgs.push(createMessage('system', `[对话摘要] ${result.conversation_summary}`))
    }

    for (const entry of result.entries) {
      if (entry.type === 'user') {
        const blocks = entry.content as UserContentBlock[]
        const hasText = blocks.some((b) => b.type === 'text')
        if (!hasText) continue
        msgs.push({
          id: entry.uuid,
          role: 'user',
          content: blocks.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join(''),
          timestamp: entry.timestamp,
        })
      } else if (entry.type === 'assistant') {
        const blocks = entry.content as AssistantContentBlock[]
        // 构建 segments，保留原始顺序
        const segments: AssistantSegment[] = blocks.map((b) => {
          if (b.type === 'text') {
            return { type: 'text' as const, text: b.text }
          } else {
            const result = toolOutputs.get(b.id)
            return {
              type: 'tool' as const,
              call: {
                tool_use_id: b.id,
                tool_name: b.name,
                input: b.input,
                status: result ? (result.is_error ? 'error' as const : 'completed' as const) : 'completed' as const,
                output: result?.output,
              },
            }
          }
        })
        msgs.push({
          id: entry.uuid,
          role: 'assistant',
          content: '',
          segments,
          timestamp: entry.timestamp,
        })
      }
    }

    messages.value = msgs
  }

  watch(sessionId, (newId) => {
    if (newId) loadHistory(newId)
  })

  return { messages, streamingText, isStreaming, tokenUsage, send, currentTurnSegments }
}
```

- [ ] **Step 2: 验证前端构建**

Run: `npm run build`
Expected: 类型检查通过

- [ ] **Step 3: Commit**

```
refactor: useChat — AssistantSegment 模型替代 content+toolCalls
```

---

## Task 5: 前端 — MessageBubble + ChatView 视觉重构

**Files:**
- Modify: `src/components/MessageBubble.vue`
- Modify: `src/components/ChatView.vue`

- [ ] **Step 1: 重写 MessageBubble.vue**

根据 spec 的视觉规范重写模板：

- User 消息：右对齐，标题行 `→ User`，卡片背景 `bg-bg-elevated`，左侧 3px 灰色色条
- Assistant 消息：左对齐，标题行 `λ Assistant`（λ 带绿色背景标签），遍历 `segments` 渲染
  - text segment → 左对齐卡片 + 3px 绿色色条
  - tool segment → 渲染 ToolCallCard（不再单独的 toolCalls 数组）
- System 消息：保持现有红色样式不变
- 流式场景：当 `currentTurnSegments` 有内容时，渲染最后一个 text segment + 闪烁光标

Assistant 消息不再使用 `streamingText` prop，改为通过 `currentTurnSegments` 渲染流式内容。

- [ ] **Step 2: 验证前端构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 3: Commit**

```
feat: MessageBubble 视觉重构 — 统一侧边色条 + 角色标记 + segments 渲染
```

---

## Task 6: 前端 — ToolCallCard 默认展开 + 危险等级颜色

**Files:**
- Modify: `src/components/ToolCallCard.vue`

- [ ] **Step 1: 重写 ToolCallCard.vue**

关键改动：
1. 移除 `isExpanded` ref 和折叠按钮，输出区默认展开
2. 添加 `dangerLevel` prop（从 `getToolDangerLevel(toolCall.tool_name)` 计算）
3. 侧边色条和 header 背景色按危险等级区分：
   - safe: 绿色 `#22c55e`
   - caution: 黄色 `#eab308`
   - error: 红色 `#ef4444`（由 `toolCall.status === 'error'` 决定，覆盖 dangerLevel）

Props 变更：
```typescript
const props = defineProps<{
  toolCall: ToolCallDisplay
}>()

const dangerLevel = computed(() => getToolDangerLevel(props.toolCall.tool_name))
```

颜色逻辑：`status === 'error'` 时使用红色，否则使用 dangerLevel 对应颜色。

- [ ] **Step 2: 验证前端构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 3: Commit**

```
feat: ToolCallCard 默认展开 + 危险等级色条 (safe/caution/error)
```

---

## Task 7: 前端 — Topbar 组件

**Files:**
- Create: `src/components/Topbar.vue`

- [ ] **Step 1: 创建 Topbar.vue**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { isTauri } from '../lib/tauri'

const props = defineProps<{
  sidebarCollapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'navigate', page: 'chat' | 'settings'): void
}>()

const currentPage = ref<'chat' | 'settings'>('chat')
const modelName = ref('loading...')

if (isTauri()) {
  import('../lib/tauri').then(({ getCurrentModel }) => {
    getCurrentModel().then((m) => { modelName.value = m })
  })
}

function navigate(page: 'chat' | 'settings') {
  currentPage.value = page
  emit('navigate', page)
}
</script>

<template>
  <div class="flex h-10 shrink-0 items-center border-b border-border-default bg-bg-elevated px-4">
    <!-- 左: logo -->
    <span class="font-mono text-sm font-semibold text-accent">xyz-agent</span>

    <!-- 中: 导航 -->
    <div class="ml-6 flex gap-1">
      <button
        class="rounded px-3 py-1 font-mono text-xs transition-colors"
        :class="currentPage === 'chat'
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-primary'"
        @click="navigate('chat')"
      >
        Chat
      </button>
      <button
        class="rounded px-3 py-1 font-mono text-xs transition-colors"
        :class="currentPage === 'settings'
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-primary'"
        @click="navigate('settings')"
      >
        Settings
      </button>
    </div>

    <!-- 右: 模型名 + 折叠按钮 -->
    <div class="ml-auto flex items-center gap-3">
      <span class="font-mono text-[11px] text-text-tertiary">{{ modelName }}</span>
      <button
        class="text-text-tertiary transition-colors hover:text-text-primary"
        @click="$emit('toggle-sidebar')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18" />
        </svg>
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```
feat: Topbar 组件 — Chat/Settings 导航 + Sidebar 折叠按钮
```

---

## Task 8: 前端 — SettingsView 组件 + useSettings composable

**Files:**
- Create: `src/components/SettingsView.vue`
- Create: `src/composables/useSettings.ts`
- Modify: `src/lib/tauri.ts`

- [ ] **Step 1: 在 tauri.ts 中添加 get_config / update_config 封装**

```typescript
export async function getConfig() {
  return invoke<ConfigResponse>('get_config')
}

export async function updateConfig(payload: UpdateConfigRequest) {
  return invoke<void>('update_config', { payload })
}
```

同时在 `src/types/index.ts` 中添加：

```typescript
export interface ConfigResponse {
  anthropic_api_key: string
  llm_model: string
  anthropic_base_url: string
  max_turns: number
  context_window: number
  max_output_tokens: number
  tool_output_max_bytes: number
  bash_default_timeout_secs: number
}

export interface UpdateConfigRequest {
  anthropic_api_key: string
  llm_model: string
  anthropic_base_url: string
  max_turns: number
  context_window: number
  max_output_tokens: number
  tool_output_max_bytes: number
  bash_default_timeout_secs: number
}
```

- [ ] **Step 2: 创建 useSettings.ts**

```typescript
import { ref } from 'vue'
import { getConfig, updateConfig, isTauri } from '../lib/tauri'
import type { ConfigResponse, UpdateConfigRequest } from '../types'

export function useSettings() {
  const config = ref<ConfigResponse | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const success = ref(false)

  async function load() {
    if (!isTauri()) return
    loading.value = true
    error.value = null
    try {
      config.value = await getConfig()
    } catch (e) {
      error.value = String(e)
    } finally {
      loading.value = false
    }
  }

  async function save() {
    if (!config.value) return
    saving.value = true
    error.value = null
    success.value = false
    try {
      const payload: UpdateConfigRequest = {
        anthropic_api_key: config.value.anthropic_api_key,
        llm_model: config.value.llm_model,
        anthropic_base_url: config.value.anthropic_base_url,
        max_turns: config.value.max_turns,
        context_window: config.value.context_window,
        max_output_tokens: config.value.max_output_tokens,
        tool_output_max_bytes: config.value.tool_output_max_bytes,
        bash_default_timeout_secs: config.value.bash_default_timeout_secs,
      }
      await updateConfig(payload)
      success.value = true
      setTimeout(() => { success.value = false }, 3000)
    } catch (e) {
      error.value = String(e)
    } finally {
      saving.value = false
    }
  }

  return { config, loading, saving, error, success, load, save }
}
```

- [ ] **Step 3: 创建 SettingsView.vue**

设置页面分两个区域：LLM 配置和 Agent 配置。

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettings } from '../composables/useSettings'

const { config, loading, saving, error, success, load, save } = useSettings()

onMounted(() => { load() })
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <h2 class="mb-6 text-lg font-semibold text-text-primary">Settings</h2>

    <div v-if="loading" class="text-text-tertiary">Loading...</div>
    <div v-else-if="error" class="text-accent-red">{{ error }}</div>

    <div v-else-if="config" class="space-y-8">
      <!-- LLM 配置 -->
      <section>
        <h3 class="mb-3 text-sm font-medium text-text-secondary">LLM Configuration</h3>
        <div class="space-y-3">
          <div>
            <label class="mb-1 block text-xs text-text-tertiary">API Key</label>
            <input
              v-model="config.anthropic_api_key"
              type="password"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs text-text-tertiary">Model</label>
            <input
              v-model="config.llm_model"
              type="text"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs text-text-tertiary">Base URL</label>
            <input
              v-model="config.anthropic_base_url"
              type="text"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            />
          </div>
        </div>
      </section>

      <!-- Agent 配置 -->
      <section>
        <h3 class="mb-3 text-sm font-medium text-text-secondary">Agent Configuration</h3>
        <div class="grid grid-cols-2 gap-3">
          <div v-for="field of [
            { key: 'max_turns', label: 'Max Turns', min: 1, max: 200 },
            { key: 'context_window', label: 'Context Window', min: 1000, max: 1000000 },
            { key: 'max_output_tokens', label: 'Max Output Tokens', min: 256, max: 100000 },
            { key: 'tool_output_max_bytes', label: 'Tool Output Max Bytes', min: 1000, max: 1000000 },
            { key: 'bash_default_timeout_secs', label: 'Bash Timeout (sec)', min: 1, max: 600 },
          ]" :key="field.key">
            <label class="mb-1 block text-xs text-text-tertiary">{{ field.label }}</label>
            <input
              v-model.number="config[field.key as keyof typeof config]"
              type="number"
              :min="field.min"
              :max="field.max"
              class="w-full rounded-md border border-border-default bg-bg-inset px-3 py-2 font-mono text-sm text-text-primary"
            />
          </div>
        </div>
      </section>

      <!-- 保存 -->
      <div class="flex items-center gap-3">
        <button
          class="rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg-base transition-colors hover:bg-accent/80"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <span v-if="success" class="text-xs text-accent">Saved. Restart to apply changes.</span>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 验证前端构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 5: Commit**

```
feat: SettingsView + useSettings — 配置读写 UI
```

---

## Task 9: 前端 — App.vue 集成 Topbar + 路由 + Sidebar 折叠

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/Sidebar.vue`

- [ ] **Step 1: 修改 Sidebar.vue 支持折叠 + 移除重复 Logo**

将 `w-[240px]` 改为动态宽度，通过 prop 控制。同时移除顶部 Logo 区域（第 18-24 行），因为 Topbar 已承担品牌展示：

```vue
<script setup lang="ts">
const props = defineProps<{
  collapsed?: boolean
}>()
</script>

<template>
  <div
    class="flex h-full shrink-0 flex-col border-r border-border-default bg-bg-elevated transition-all duration-200"
    :class="collapsed ? 'w-0 overflow-hidden' : 'w-[240px]'"
  >

```vue
<script setup lang="ts">
const props = defineProps<{
  collapsed?: boolean
}>()
</script>

<template>
  <div
    class="flex h-full shrink-0 flex-col border-r border-border-default bg-bg-elevated transition-all duration-200"
    :class="collapsed ? 'w-0 overflow-hidden' : 'w-[240px]'"
  >
    <!-- 现有内容不变 -->
  </div>
</template>
```

- [ ] **Step 2: 重写 App.vue 集成 Topbar + 路由**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import Topbar from './components/Topbar.vue'
import ChatView from './components/ChatView.vue'
import SettingsView from './components/SettingsView.vue'
import { useSession } from './composables/useSession'

const { currentSessionId } = useSession()
const sidebarCollapsed = ref(false)
const currentPage = ref<'chat' | 'settings'>('chat')
</script>

<template>
  <div class="flex h-screen flex-col bg-bg-surface text-text-primary">
    <Topbar
      :sidebar-collapsed="sidebarCollapsed"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      @navigate="(page) => { currentPage = page }"
    />

    <div class="flex flex-1 overflow-hidden">
      <Sidebar :collapsed="sidebarCollapsed" />
      <ChatView v-if="currentPage === 'chat'" :current-session-id="currentSessionId" />
      <SettingsView v-else />
    </div>
  </div>
</template>
```

- [ ] **Step 3: 验证前端构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 4: 启动应用手动验证**

Run: `npm run tauri dev`
验证：
- Topbar 显示 Chat/Settings 导航
- 点击 Settings 切换到设置页面
- 点击 Chat 切换回聊天
- Sidebar 折叠/展开正常
- 窗口大小约为屏幕 75%

- [ ] **Step 5: Commit**

```
feat: App 集成 Topbar + Chat/Settings 路由 + Sidebar 折叠
```

---

## Task 10: 端到端验证 + 修复

**Files:** 无固定文件

- [ ] **Step 1: 运行完整测试套件**

Run: `cd src-tauri && cargo test`
Expected: 全部通过

- [ ] **Step 2: 运行前端构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 3: 手动测试检查清单**

- [ ] 窗口启动时大小约为屏幕 75%
- [ ] Topbar Chat/Settings 切换正常
- [ ] Sidebar 折叠/展开动画流畅
- [ ] User 消息右对齐，有灰色侧边色条，有 `→ User` 标记
- [ ] Assistant 消息左对齐，有绿色侧边色条，有 `λ Assistant` 标记
- [ ] 工具调用在 Assistant 消息内按原始顺序渲染
- [ ] Read 工具绿色侧边 (safe)，Bash/Write 黄色侧边 (caution)
- [ ] 失败的工具调用红色侧边 (error)
- [ ] 工具调用默认展开输出区
- [ ] 设置页面加载显示当前配置
- [ ] 修改配置并保存成功
- [ ] 流式场景：文本和工具调用在同一个消息组内渲染

- [ ] **Step 4: 修复发现的问题并提交**

```
fix: 端到端验证修复
```
