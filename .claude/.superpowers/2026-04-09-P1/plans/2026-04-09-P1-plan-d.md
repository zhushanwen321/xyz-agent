# Plan D: 前端 + AppState 集成

> 依赖：Plan A + B + C（全部后端变更）

---

## Task 22: AppState 初始化更新

**Files:**
- Modify: `src-tauri/src/commands/session.rs`
- Modify: `src-tauri/src/lib.rs`

**Spec 参考:** 所有 spec 的 AppState 章节

- [ ] **Step 1: 更新 AppState**

```rust
pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub tool_registry: Arc<ToolRegistry>,      // Plan A
    pub global_perms: PermissionContext,        // Plan A
    pub agent_config: AgentConfig,              // Plan A Task 9
    pub context_config: ContextConfig,          // Plan C
    pub prompt_manager: PromptManager,          // Plan C
}
```

- [ ] **Step 2: 更新 lib.rs 初始化**

```
1. 加载 AgentConfig（Plan A Task 9）
2. 创建 ToolRegistry, register_builtin_tools
3. 创建 PermissionContext（默认：全允许）
4. 创建 ContextConfig（从 AgentConfig 字段映射）
5. 创建 PromptManager
6. 存入 AppState
```

- [ ] **Step 3: 更新 chat.rs 使用 AppState 的新字段**

- [ ] **Step 4: 更新 get_history command 返回类型**

```rust
// 旧：返回 Vec<TranscriptEntry>
// 新：返回 LoadHistoryResult（含 conversation_summary）
#[tauri::command]
pub async fn get_history(session_id: String, state: State<'_, AppState>) -> Result<LoadHistoryResult, String> {
    let path = jsonl::session_path(&state.data_dir, &session_id);
    jsonl::load_history(&path).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: 更新 services/mod.rs 统一声明**

确保所有新模块都在 `mod.rs` 中声明：
```rust
pub mod agent_loop;
pub mod config;           // Plan A Task 9: AgentConfig
pub mod context_manager;  // Plan C: ContextManager
pub mod data_context;     // Plan C: DataContext
pub mod llm;
pub mod prompt_manager;   // Plan C: PromptManager
pub mod tool_executor;    // Plan A: ToolExecutor
pub mod tool_registry;    // Plan A: ToolRegistry
pub mod tools;            // Plan A: 内置工具
```

- [ ] **Step 6: 提交**

```bash
cargo test && git commit -m "feat: AppState 集成全部 P1 模块"
```

---

## Task 23: types/index.ts + lib/tauri.ts 更新

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/tauri.ts`

**Spec 参考:** AgentLoop spec 前端变更详情

- [ ] **Step 1: 新增 ContentBlock 类型**

```typescript
type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }

type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
```

- [ ] **Step 2: 更新 TranscriptEntry 类型**

User/Assistant 的 content 从 `string` 改为 `AssistantContentBlock[]` / `UserContentBlock[]`。

- [ ] **Step 3: 新增 AgentEvent 变体**

```typescript
type AgentEvent =
  | ... // 现有
  | { type: 'ToolCallStart'; session_id: string; tool_name: string; tool_use_id: string }
  | { type: 'ToolCallEnd'; session_id: string; tool_use_id: string; is_error: boolean }
```

- [ ] **Step 4: 更新 lib/tauri.ts**

```typescript
// get_history 返回值从 TranscriptEntry[] 改为 LoadHistoryResult
interface LoadHistoryResult {
  entries: TranscriptEntry[]
  conversation_summary: string | null
}

export async function getHistory(sessionId: string): Promise<LoadHistoryResult> {
  return invoke<LoadHistoryResult>('get_history', { sessionId })
}
```

- [ ] **Step 5: 更新 useSession.ts**

```typescript
// loadSession 使用新的 LoadHistoryResult
async function loadSession(id: string) {
  const result = await getHistory(id)
  currentSession.value = { id, conversation_summary: result.conversation_summary }
  return result.entries  // history 由 useChat 管理
}
```

- [ ] **Step 6: 提交**

```bash
npm run build && git commit -m "feat: 前端类型更新 — ContentBlock + AgentEvent + LoadHistoryResult"
```

---

## Task 24: useChat.ts + ChatView.vue 更新

**Files:**
- Modify: `src/composables/useChat.ts`
- Modify: `src/components/ChatView.vue`

**Spec 参考:** AgentLoop spec 前端变更详情

- [ ] **Step 1: 更新 useChat loadHistory**

从 ContentBlock 数组中提取文本：
```typescript
function extractTextFromBlocks(blocks: AssistantContentBlock[] | UserContentBlock[]): string {
  return blocks
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('\n')
}
```

- [ ] **Step 2: 添加 ToolCallState 管理**

```typescript
interface ToolCallState {
  tool_use_id: string
  tool_name: string
  is_running: boolean
  is_error: boolean
}
const activeToolCalls = ref<Map<string, ToolCallState>>(new Map())
```

- [ ] **Step 3: 处理新的 AgentEvent**

```typescript
case 'ToolCallStart':
  activeToolCalls.value.set(event.tool_use_id, {
    tool_use_id: event.tool_use_id,
    tool_name: event.tool_name,
    is_running: true,
    is_error: false,
  })
  break
case 'ToolCallEnd':
  const call = activeToolCalls.value.get(event.tool_use_id)
  if (call) {
    call.is_running = false
    call.is_error = event.is_error
  }
  break
```

- [ ] **Step 4: 暴露给 ChatView**

```typescript
return {
  // ...现有
  activeToolCalls: readonly(activeToolCalls),
}
```

- [ ] **Step 5: 更新 ChatView.vue 流式工具状态**

在流式输出期间，如果有 activeToolCalls 中 `is_running` 的条目，在最后一条 assistant 消息下方显示工具调用状态行（如 "正在执行 Read..."）。

- [ ] **Step 6: 提交**

```bash
npm run build && git commit -m "feat: useChat 工具调用事件处理 + ChatView 流式状态"
```

---

## Task 25: MessageBubble.vue 工具调用卡片

**Files:**
- Modify: `src/components/MessageBubble.vue`

**Spec 参考:** AgentLoop spec 前端变更详情

- [ ] **Step 1: 添加工具调用状态展示**

在 assistant 消息中，如果 `activeToolCalls` 有正在运行的调用，显示内联卡片：
- 工具名 + 参数摘要
- 旋转图标（执行中）/ 绿勾（完成）/ 红叉（失败）

- [ ] **Step 2: 处理历史消息中的 ToolUse blocks**

从 history 加载的消息如果包含 ToolUse content blocks，渲染为折叠卡片。

- [ ] **Step 3: 提交**

```bash
npm run build && git commit -m "feat: MessageBubble 工具调用卡片渲染"
```

---

## Task 26: StatusBar.vue 更新

**Files:**
- Modify: `src/components/StatusBar.vue`

**Spec 参考:** ContextManager spec 前端变更详情

- [ ] **Step 1: 显示 token 消耗**

从 `useChat` 暴露累计 token 值，StatusBar 显示如 "tokens: 12.4k"。

- [ ] **Step 2: 显示工具执行状态**

有活跃工具调用时显示 "执行工具中..." + 工具名。

- [ ] **Step 3: 提交**

```bash
npm run build && git commit -m "feat: StatusBar token 消耗 + 工具状态显示"
```

---

## Task 27: 端到端集成测试

**Files:**
- All

- [ ] **Step 1: 启动应用 `npm run tauri dev`**

- [ ] **Step 2: 验证基础对话**

发送消息，确认流式输出正常。

- [ ] **Step 3: 验证工具调用**

发送 "读取 Cargo.toml 文件"，确认 Agent 调用 Read 工具，前端展示工具卡片和结果。

- [ ] **Step 4: 验证 Session 管理**

新建/切换/删除 session，确认历史加载正确（含 ContentBlock 格式）。

- [ ] **Step 5: 最终提交**

```bash
git commit --allow-empty -m "test: P1 端到端验证通过"
```

---

**Plan D 完成标志**: `npm run tauri dev` 能正常启动，Agent 能调用工具并展示在 UI 中。
