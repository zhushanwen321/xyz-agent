# Architecture Optimization v2: 五项目综合分析 → xyz-agent 实施指南

**Date**: 2026-05-06 | **Based on**: arch-optimization.md (v1) + ref-claude-code.md + ref-codex-opencode.md + ref-aider-crush.md + spec-v2.md
**Status**: Comprehensive Design Proposal — supersedes arch-optimization.md v1

> 本文档综合 Claude Code、Codex CLI、Aider、OpenCode、Crush 五个编码 Agent 的源码分析结果，提炼 xyz-agent 应借鉴的 10 项核心设计，映射到 spec-v2 的具体修改点，并给出合并后的优先级矩阵和实施顺序。

---

## 1. 五个项目的核心差异总结

| 维度 | Claude Code | Codex CLI | Aider | OpenCode | Crush | pi (xyz-agent base) |
|------|-------------|-----------|-------|---------|-------|---------------------|
| **语言** | TypeScript | Rust (628K 行) | Python | Go (42K 行) | Go | Rust + Vue 3 |
| **Agent 循环模式** | `async function*` AsyncGenerator + 状态机整体替换 | ThreadManager 线程池，每个 Thread = Agent | ReAct 循环封装在 Coder 子类 | 简洁 ReAct `for` 循环 + `select` 取消检查 | 三层: Coordinator → SessionAgent → Fantasy SDK ReAct | `run_turn()` 显式 while 循环 + `consume_stream()` 聚合 |
| **子 Agent 机制** | 三层调度: Teammate / Remote / Worktree / Fork(共享 prompt cache) | Thread 线程池 + Weak 引用防循环 + SpawnReservation RAII | 无子 Agent | 无子 Agent | SessionAgent 子会话 + parent_session_id 关联 | DispatchAgent(fork 模式) + Orchestrate(编排模式)，最大深度 5 |
| **工具审批** | 5 层防线: validateInput → checkPermissions → PreToolUse Hooks → 权限模式 → 分类器+UI对话框 | ApprovalStore + 沙箱 + 渐进提权(先受限执行,失败后请求无沙箱) | 无审批机制 | 120 行 pubsub 桥接: 工具 goroutine 阻塞 Request ↔ TUI Grant/Deny | 5 层链: skip → allowed_tools → autoApproveSessions → sessionPermissions → 完整 UI 请求 | PermissionContext 白名单/黑名单 + safe/caution/danger 三级 |
| **会话管理** | JSONL 事件溯源 + 内存 TranscriptEntry | JSONL 事件源 + SQLite 读模型投影 + 异步 RolloutRecorder | 文件系统，自动 Git commit 每次编辑 | SQLite (WASM) | SQLite + XXH3 HashID + 子会话 parent_session_id | JSONL 持久化 (store/) |
| **上下文压缩** | 5 层渐进: History Snip → Microcompact → Context Collapse → AutoCompact → Reactive Compact (413 恢复) + Post-Compact 恢复 | Compact (LLM 摘要) | ChatChunks 分块组装 + Repo Map 代码图谱 | Auto-compact (配置存在但未完整实现) | 小模型压缩历史 + SHA-256 循环检测 | trim + LLM 摘要 + 熔断 (context/mod.rs) |
| **权限模型** | yolo/auto/default 三模式 + 工具级 `checkPermissions()` + 白名单/黑名单 + ML 分类器 | approval(skip/need/forbidden) + ApprovalStore 缓存 + 沙箱 | 无 | allow/auto-ask/deny 三级 + 交互式 TUI 弹窗 + 白/黑名单路径过滤 | skip → allowed_tools → sessionPermissions → 完整请求(串行化) + YOLO 全局 bypass | safe/caution/danger + PermissionContext 白/黑名单 |
| **Provider 抽象** | 仅 Anthropic (自有产品) | OpenAI + Ollama + LM Studio | LiteLLM (统一所有模型接口) | 泛型 `baseProvider[C]` + 5 种 Client (Anthropic/OpenAI/Gemini/Copilot/Bedrock) + 12 Provider | Fantasy SDK (7+ Provider) | ProviderRegistry 按 `provider/modelId` 路由 + Anthropic 实现 |

**核心洞察**: xyz-agent 的独特优势在于 **Rust 性能/安全性** + **Tauri 桌面 GUI** + **已有的子 Agent 编排 (Orchestrate/DispatchAgent)**。借鉴时应优先强化这些优势，而非简单复制其他项目的架构决策。

---

## 2. xyz-agent 特别应该借鉴的 10 项设计

### 2.1 Claude Code 的子代理系统 (Phase: P5/P6)

**来源**: Claude Code — `AgentTool.call()`, `createSubagentContext()`, Fork 机制

**设计内容**:

- **PermissionContext 继承**: 子 Agent 继承父级白名单/黑名单，但可进一步收窄
- **ToolExecutionContext 共享**: 通过 `createSubagentContext()` 克隆文件缓存、no-op 全局状态修改、root 级 bash 任务注册
- **并发控制分区**: 连续 safe 工具合并为 batch 并行执行，unsafe 工具独立串行，上限 10
- **Fork 模式**: 5 个 CacheSafeParams (system/tools/model/messages/thinking) 完全匹配时共享 prompt cache，子级只追加 directive 文本块
- **Agent 类型体系**: Explore(只读+haiku)、Plan(禁止写)、verification(对抗性验证)、general-purpose(全量)

**为什么重要**: xyz-agent 已有 DispatchAgent + Orchestrate，但缺少状态隔离、Fork cache 共享、和精细的 Agent 类型控制。子 Agent 系统是 P5/P6 的核心差异化能力。

**实现建议**:

```typescript
// 前端: 子 Agent Tab 管理器 (P5)
// src/composables/useTabManager.ts
interface SubAgentTab {
  id: string
  parentId: string
  agentType: 'general-purpose' | 'explore' | 'plan' | 'verification'
  status: 'running' | 'idle' | 'completed' | 'failed'
  depth: number          // 嵌套深度
  tokenUsage: number
  toolCalls: ToolCall[]
}

// src/stores/agent.ts (P5 新增 store)
export const useAgentStore = defineStore('agent', () => {
  const tabs = ref<SubAgentTab[]>([])
  const activeTabId = ref<string | null>(null)

  function registerSubAgent(tab: SubAgentTab) {
    tabs.value = [...tabs.value, tab]
  }
  function removeSubAgent(id: string) {
    tabs.value = tabs.value.filter(t => t.id !== id)
  }
  return { tabs, activeTabId, registerSubAgent, removeSubAgent }
})
```

```rust
// 后端: 状态隔离增强 (P5)
// engine/tools/dispatch_agent.rs — 增强 create_subagent_context()
pub fn create_subagent_context(parent: &ToolExecutionContext) -> ToolExecutionContext {
    ToolExecutionContext {
        // 克隆文件缓存，防止子 Agent 污染主会话
        read_files: parent.read_files.clone(),
        // 默认 no-op: 子 Agent 不能修改全局状态
        set_app_state: Box::new(|_| {}),
        // bash 任务注册始终指向 root，防止僵尸进程
        set_app_state_for_tasks: parent.set_app_state_for_tasks.clone(),
        // 独立 Agent ID
        agent_id: AgentId::new(),
        // 深度 +1
        depth: parent.depth + 1,
    }
}
```

**阶段**: P5 (SubAgent 拆分/Tab/任务树)

---

### 2.2 Claude Code 的 Agent 循环 (Phase: P1 核心渲染优化)

**来源**: Claude Code — `query()` AsyncGenerator, `StreamingToolExecutor`, `BudgetGuard`

**设计内容**:

- **`run_turn()` 主循环**: 迭代 → LLM 流式 → 工具调用 → 再迭代。状态整体替换 (`state = next`) 而非部分更新
- **`consume_stream()` SSE 聚合**: 将 LLM 流式事件聚合为结构化的 `AgentEvent` 序列
- **BudgetGuard 多维度预算**: token 上限 + turn 上限 + tool_call 上限 + diminishing returns 检测
- **流式工具执行**: 先完成的工具结果先返回给模型，不必等待全部完成 (节省 30-60% 等待时间)
- **Bash 错误级联**: BashTool 失败取消同批所有兄弟工具 (`siblingAbortController.abort()`)

**为什么重要**: xyz-agent 的 `execute_batch()` 等待全部完成，流式执行是高价值改进。BudgetGuard 已有基本实现，但缺少 diminishing returns 的精确检测。

**实现建议** (前端渲染优化 — 与 arch-optimization v1 §1.1 对齐):

```typescript
// src/stores/chat.ts — P1 核心变更
interface ChatState {
  completedMessages: Message[]                          // 冻结，不再更新
  streamingMessage: StreamingAssistantMessage | null    // 唯一更新点
  isGenerating: boolean
  pendingToolCalls: ToolCall[]
}

interface StreamingAssistantMessage {
  id: string
  textContent: string
  thinkingContent: string
  toolCalls: ToolCall[]
  startedAt: number
}

function finalizeStreamingMessage(usage: Usage, stopReason: string) {
  const streaming = chatState.streamingMessage
  if (!streaming) return
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
  chatState.completedMessages = [...chatState.completedMessages, finalMessage]
  chatState.streamingMessage = null
}
```

```vue
<!-- src/components/chat/MessageList.vue -->
<template>
  <ScrollArea ref="scrollRef">
    <MessageBubble
      v-for="msg in chatStore.completedMessages"
      :key="msg.id"
      :message="msg"
    />
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

**rAF 批处理** (与 arch-optimization v1 §1.2 对齐):

```typescript
// src/composables/useRafBatcher.ts
export function useRafBatcher() {
  let buffer = ''
  let rafId: number | null = null
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
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    buffer = ''
    flushed.value = value
  }
  onUnmounted(() => { if (rafId !== null) cancelAnimationFrame(rafId) })
  return { flushed, append, reset }
}
```

**后端流式工具执行** (P2+):

```rust
// engine/tools/executor.rs — 改进: 流式返回
pub async fn execute_batch_streaming(
    calls: Vec<ToolCallInput>,
    registry: &ToolRegistry,
    ctx: &ToolExecutionContext,
) -> impl Stream<Item = (String, ToolResult)> {
    // 分区: safe 工具并行, unsafe 工具串行
    let (safe, unsafe_) = partition_by_safety(calls);
    // safe batch: tokio::join! 并行执行
    // 每完成一个立即 yield (call_id, result)
    // unsafe batch: 串行执行, 每个 yield
}
```

**阶段**: P0 (前端渲染优化) + P2 (后端流式工具执行)

---

### 2.3 Codex CLI 的多 Agent 与线程管理 (Phase: P5/P6)

**来源**: Codex CLI — ThreadManager, SpawnReservation, Mailbox 消息传递, AgentPath 树形寻址

**设计内容**:

- **Thread = Agent**: 每个 Agent 独立配置、状态和邮箱。ThreadManager 是"内核"，AgentControl 是"系统调用接口"
- **`Weak<ThreadManagerState>`**: 避免循环引用 (ThreadManager → CodexThread → Session → ThreadManager)
- **SpawnReservation 两阶段提交**: `reserve_spawn_slot()` 原子增加计数器 → `commit()` 注册元数据 → Drop 自动回滚
- **Mailbox 消息传递**: Agent 间通过 channel 异步通信，支持纯通知 (不触发 turn) 和请求 (触发新 turn)
- **AgentPath 树形寻址**: `/root/worker1` 风格路径编码父子关系
- **分叉历史清洁化**: fork 时只保留 system/user 消息 + assistant FinalAnswer，丢弃 tool call 中间过程

**为什么重要**: xyz-agent 的 `task_tree.rs` 已有树形结构但缺少消息传递和 RAII 保护。Agent 间通信是编排复杂任务的基础。

**实现建议**:

```rust
// engine/task_tree.rs — 增强
pub struct AgentPath(String);  // "/root/worker1"

impl AgentPath {
    pub fn child(&self, name: &str) -> Self {
        AgentPath(format!("{}/{}", self.0, name))
    }
    pub fn is_descendant_of(&self, parent: &AgentPath) -> bool {
        self.0.starts_with(&parent.0)
    }
}

pub struct Mailbox {
    tx: mpsc::UnboundedSender<AgentMessage>,
    rx: Mutex<mpsc::UnboundedReceiver<AgentMessage>>,
}

pub enum AgentMessage {
    Notify(AgentEvent),           // 不触发 turn
    Request {                     // 触发新 turn
        content: String,
        reply_tx: oneshot::Sender<AgentResponse>,
    },
}

// SpawnReservation RAII guard
pub struct SpawnReservation {
    path: AgentPath,
    committed: bool,
    manager: Weak<TaskTree>,
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        if !self.committed {
            // 自动回滚: 释放 slot
            if let Some(mgr) = self.manager.upgrade() {
                mgr.release_slot(&self.path);
            }
        }
    }
}
```

**阶段**: P5/P6 (SubAgent 拆分/任务树)

---

### 2.4 Aider 的编辑格式系统 + Repo Map (Phase: P2/P3)

**来源**: Aider — EditFormat 策略模式, ChatChunks, Repo Map (tree-sitter + PageRank)

**设计内容**:

- **Edit Format**: 4 种可插拔格式 — editblock (精确 diff) / wholefile (完整文件) / udiff (unified diff) / patch (标准 patch)
- **ChatChunks**: 上下文分为 `system / context / chat / tool` 独立块，按需组装
- **Repo Map**: tree-sitter AST 解析 → networkx 图构建 → PageRank 排名 → 只输出签名级代码地图
- **Token 预算**: 根据模型 context window 动态调整 repo map 大小
- **自动 Git Commit**: 每次编辑自动 commit，用户可回滚

**为什么重要**: xyz-agent 目前只有 WriteTool (全量写入) 和 EditTool (old/new 替换)，上下文构建依赖用户手动指定文件。Repo Map 可以实现自动代码感知，大幅提升 Agent 效率。

**实现建议** (保持当前 edit 模式，引入 Repo Map):

```rust
// engine/context/repo_map.rs (P3 新增)
use tree_sitter::{Parser, Query, QueryCursor};

pub struct RepoMap {
    /// 文件 → (签名列表, PageRank 分数)
    signatures: HashMap<PathBuf, Vec<Signature>>,
    ranks: HashMap<PathBuf, f64>,
    cache: HashMap<PathBuf, CachedParse>,
}

pub struct Signature {
    kind: SignatureKind,     // Class / Function / Method / Variable / Constant
    name: String,
    line_range: (usize, usize),
    references: Vec<String>,  // 被哪些其他签名引用
}

impl RepoMap {
    /// 在 token 预算内生成代码地图
    pub fn generate(&self, budget_tokens: usize) -> String {
        // 按 PageRank 分数排序
        // 按预算截断，优先核心模块
        // 只输出签名行（不含函数体）
    }

    /// 文件变更时增量更新
    pub fn update_file(&mut self, path: &Path, content: &str) {
        // 只重新解析变更文件 + 受影响的引用图
    }
}
```

```typescript
// 前端: Edit 保持当前模式，暂不引入策略模式
// src/components/chat/tools/EditToolRenderer.vue (P1)
const props = defineProps<ToolRendererProps>()
const filePath = computed(() => (props.input as { file_path: string }).file_path ?? '')
const oldText = computed(() => (props.input as { old_text: string }).old_text ?? '')
const newText = computed(() => (props.input as { new_text: string }).new_text ?? '')
```

**采纳决策**:
- ✅ **采纳 Repo Map** (高优先级, P3): 自动代码感知
- ✅ **保持当前 edit 模式** (不引入 EditFormat 策略): GUI 应用不需要终端 diff 展示
- ✅ **参考 ChatChunks**: PromptManager 已部分实现，可增强分节缓存

**阶段**: P2 (ChatChunks 分节优化) + P3 (Repo Map)

---

### 2.5 OpenCode 的 Provider 适配层 (Phase: P2)

**来源**: OpenCode — 泛型 `baseProvider[C]`, 5 种 Client, OpenAI 兼容标准复用, Prompt Caching 自动注入

**设计内容**:

- **统一 Provider 接口**: 3 个方法: `SendMessages / StreamResponse / Model`
- **泛型外壳**: `baseProvider[C ProviderClient]` 处理消息清理 + 委托
- **OpenAI 兼容复用**: Groq/OpenRouter/XAI/Local 只改 base URL，零额外代码
- **委托模式**: Bedrock → AnthropicClient，Azure → OpenAI Client
- **Prompt Caching**: Anthropic 自动为最近 3 条消息 + 最后一个工具添加 `cache_control: ephemeral`
- **Thinking 模式**: 动态激活时强制 `temperature = 1` (Anthropic 要求)

**为什么重要**: xyz-agent 当前只有 Anthropic 实现。多 Provider 支持是产品化的基础需求，且 OpenAI 兼容 API 覆盖大量供应商。

**实现建议**:

```rust
// engine/llm/registry.rs — 扩展
pub trait LlmProvider: Send + Sync {
    fn chat_stream(&self, req: ChatRequest) -> Pin<Box<dyn Stream<Item = LlmStreamEvent>>>;
    fn list_models(&self) -> Vec<ModelEntry>;
    fn name(&self) -> &str;
}

// engine/llm/openai_compat.rs (P2 新增)
pub struct OpenAiCompatProvider {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
    model_map: HashMap<String, String>,  // display name → API model id
}

impl LlmProvider for OpenAiCompatProvider {
    fn chat_stream(&self, req: ChatRequest) -> Pin<Box<dyn Stream<Item = LlmStreamEvent>>> {
        // 统一 SSE 解析 → LlmStreamEvent 枚举
    }
}

// 自动创建: Groq, OpenRouter, DeepSeek, Local(Ollama) 全部复用
pub fn create_groq_provider(api_key: &str) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new("https://api.groq.com/openai/v1", api_key)
}
pub fn create_openrouter_provider(api_key: &str) -> OpenAiCompatProvider {
    OpenAiCompatProvider::new("https://openrouter.ai/api/v1", api_key)
}
```

**Anthropic Prompt Caching 注入** (P2 零成本优化):

```rust
// engine/llm/anthropic.rs — 增加 cache_control
fn build_messages_with_caching(messages: Vec<Message>) -> Vec<ApiMessage> {
    let mut api_messages = convert_messages(messages);
    // 最近 3 条消息添加 ephemeral cache breakpoint
    for msg in api_messages.iter_mut().rev().take(3) {
        msg.cache_control = Some(CacheControl { r#type: "ephemeral".into() });
    }
    api_messages
}
```

**阶段**: P2 (多 Provider 支持)

---

### 2.6 OpenCode 的权限系统 (Phase: P1/P2)

**来源**: OpenCode — 120 行 pubsub 桥接, 会话级审批缓存, 权限拒绝级联取消, Bash 三层安全

**设计内容**:

- **三层模型**: 工具 goroutine 阻塞 `Request()` ↔ pubsub 桥接 ↔ TUI `Grant/Deny`
- **三种授权粒度**: `Grant` (单次) / `GrantPersistent` (会话内同类自动批准) / `AutoApproveSession` (非交互模式全部自动)
- **级联取消**: 拒绝一个 → 同响应中所有后续工具也取消 + `FinishReason=PermissionDenied`
- **Bash 三层**: banned (curl/wget/nc) → safe (ls/git status 自动放行) → 其他 (需审批)
- **路径归一化**: 项目内文件统一归一化到项目根 → 一次授权覆盖所有项目内文件

**为什么重要**: xyz-agent 有 PermissionContext 但缺少用户交互确认、审批缓存、和级联取消。安全性是 Agent 产品的信任基础。

**实现建议**:

```typescript
// shared/protocol.ts — 新增权限协议消息
interface ToolCallPendingEvent {
  type: 'message.tool_call_pending'
  payload: {
    sessionId: string
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    dangerLevel: 'safe' | 'caution' | 'danger'
    autoApproved: boolean
  }
}

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

```vue
<!-- src/components/chat/ToolApprovalDialog.vue (P1) -->
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
</script>

<template>
  <Dialog :open="true" @update:open="emit('deny')">
    <div class="p-4 space-y-3">
      <div class="flex items-center gap-2">
        <Badge :variant="dangerLevel === 'danger' ? 'danger' : 'warning'" :dot="true" />
        <span class="font-mono">{{ toolName }}</span>
        <span :class="{
          'text-success': dangerLevel === 'safe',
          'text-warning': dangerLevel === 'caution',
          'text-danger': dangerLevel === 'danger',
        }">{{ dangerLevel }}</span>
      </div>
      <pre class="text-sm bg-bg-base rounded p-2 max-h-48 overflow-auto">
        {{ JSON.stringify(input, null, 2) }}
      </pre>
      <div class="flex gap-2 justify-end">
        <Button variant="ghost" @click="emit('deny')">Deny</Button>
        <Button variant="ghost" @click="emit('alwaysAllow')">Always Allow</Button>
        <Button variant="primary" @click="emit('approve')">Approve</Button>
      </div>
    </div>
  </Dialog>
</template>
```

```rust
// 后端: Bash 安全白名单 (P1)
// engine/tools/bash/mod.rs
const SAFE_COMMANDS: &[&str] = &[
    "ls", "dir", "cat", "head", "tail", "wc", "echo",
    "git status", "git log", "git diff", "git branch",
    "pwd", "which", "whoami", "env",
    "cargo check", "cargo test", "cargo build",
    "npm run", "npm test", "npm run build",
];

const BANNED_COMMANDS: &[&str] = &[
    "curl", "wget", "nc", "ncat", "telnet",
    "rm -rf /", "mkfs", "dd if=",
];
```

**阶段**: P1 (审批对话框架 + Bash 白名单) + P2 (会话级缓存 + 级联取消)

---

### 2.7 Crush 的 LSP 集成 (Phase: P3+)

**来源**: Crush — 懒启动 LSP, VersionedMap 诊断缓存, grep + LSP 混合引用查找

**设计内容**:

- **懒启动**: 按文件类型按需启动语言服务器，不预加载
- **一个语言一个客户端**: 每种 LSP 对应一个 Client 实例
- **编辑后诊断**: edit/write 工具执行后通知 LSP `didChange` → 等待诊断 → 附加到工具响应
- **混合引用查找**: grep 粗筛 + LSP `FindReferences` 精确定位
- **超时分级**: view 300ms / edit 5s / FindReferences 5s
- **VersionedMap 诊断缓存**: 写入时自增版本号，读取时只比较版本号

**为什么重要**: LSP 集成是实现"编辑 → 验证 → 修复"闭环的关键。没有诊断反馈，Agent 无法检测编辑是否引入了编译错误。

**实现建议** (P3+ 长期规划，短期用轻量替代):

```rust
// engine/lsp/mod.rs (P3 新增模块)
pub struct LspManager {
    clients: HashMap<String, LspClient>,   // language → client
    diagnostics: VersionedMap<PathBuf, Vec<Diagnostic>>,
}

impl LspManager {
    pub async fn get_or_start(&mut self, language: &str) -> &LspClient {
        if !self.clients.contains_key(language) {
            let client = LspClient::start(language).await?;
            self.clients.insert(language.to_string(), client);
        }
        self.clients.get(language).unwrap()
    }

    pub async fn did_change(&self, path: &Path) -> Vec<Diagnostic> {
        let language = detect_language(path);
        let client = self.get_or_start(language).await;
        client.did_change(path).await;
        // 等待诊断 (超时 5s)
        tokio::time::timeout(Duration::from_secs(5), client.wait_diagnostics(path)).await
    }
}
```

**短期替代** (P1/P2):

```rust
// engine/tools/bash/mod.rs — 轻量验证
// 编辑后自动运行 cargo check / npm run build
async fn post_edit_verify(file_path: &Path) -> Option<String> {
    match file_path.extension()?.to_str()? {
        "rs" => run_command("cargo", &["check", "--message-format=short"]).await,
        "ts" | "vue" => run_command("npm", &["run", "build"]).await,
        _ => None,
    }
}
```

**阶段**: P3 (LSP 集成) / P1-P2 (轻量 bash 验证替代)

---

### 2.8 Claude Code 的上下文管理系统 (Phase: P1/P2)

**来源**: Claude Code — 5 层渐进压缩, Post-Compact 恢复, 熔断器, Cached Microcompact

**设计内容**:

- **5 层渐进压缩**: History Snip (零成本裁剪) → Microcompact (清除过期 tool results) → Context Collapse (归档可恢复) → AutoCompact (LLM 摘要) → Reactive Compact (413 恢复)
- **设计哲学**: 99% 通过轻量层解决，只有 1% 需要完整摘要
- **Post-Compact 恢复**: 压缩后重新注入: 最近读取文件 (50K/5个) + 已调用技能 (25K/5K截断) + Plan 文件 + 工具/Agent 增量通告
- **熔断器**: `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，连续失败后降级为结束
- **关键参数**: `AUTOCOMPACT_BUFFER_TOKENS = 13,000`，有效阈值 = contextWindow - 13K

**为什么重要**: xyz-agent 已有 trim + LLM 摘要 + 熔断，但缺少 Post-Compact 恢复 (压缩后"失忆") 和 Microcompact 层。Post-Compact 恢复是解决"压缩后 Agent 忘记之前读过什么"的关键。

**实现建议**:

```rust
// engine/context/mod.rs — 增强 ContextManager

/// Post-Compact 恢复: 压缩后重新注入关键状态
pub fn post_compact_inject(
    &self,
    messages: &mut Vec<ApiMessage>,
    data_context: &DataContext,
) {
    let mut budget = 75_000; // 75K token 恢复预算

    // 1. 最近读取的文件 (最多 5 个，每个 5K 截断)
    for file in data_context.recent_files().take(5) {
        let content = truncate_to_tokens(&file.content, 5_000);
        messages.push(system_message(format!("[Previously read file: {}]\n{}", file.path, content)));
        budget -= 5_000;
        if budget <= 0 { break; }
    }

    // 2. 当前任务状态 (Plan 文件等)
    if let Some(plan) = data_context.current_plan() {
        messages.push(system_message(format!("[Current plan]\n{}", plan)));
    }

    // 3. Agent 类型 + 工具增量通告
    // 只通告变化部分 (delta)，不重新发送全部工具定义
}
```

```typescript
// 前端: 上下文用量展示增强 (P1)
// src/components/chat/ContextBar.vue
const usageColor = computed(() => {
  const pct = chatStore.contextUsagePercent
  if (pct > 95) return 'danger'
  if (pct > 80) return 'warning'
  return 'accent'  // 正常
})
```

**Microcompact 层** (P2):

```rust
// engine/context/microcompact.rs (P2 新增)
/// 清除过期/过大的 tool results，不修改消息内容
/// 只标记需要清除的 tool_result，在 API 请求时跳过
pub fn microcompact(messages: &mut Vec<TranscriptEntry>) -> usize {
    let mut saved = 0;
    for entry in messages.iter_mut() {
        if let TranscriptEntry::ToolResult(result) = entry {
            // 超过 10K 字符的 tool result → 截断为摘要
            if result.content.len() > 10_000 {
                saved += result.content.len() - 200;
                result.content = result.content[..200].to_string() + "\n... (truncated)";
            }
        }
    }
    saved
}
```

**阶段**: P1 (前端用量展示 + 熔断) + P2 (Post-Compact 恢复 + Microcompact)

---

### 2.9 Claude Code 的记忆系统 (Phase: P3+)

**来源**: Claude Code — extractMemories, SessionMemory, autoDream, CODE.md/CLAUDE.md 分层记忆

**设计内容**:

- **四种记忆子系统**: extractMemories (跨会话, fire-and-forget) → SessionMemory (会话内, post-sampling) → autoDream (记忆巩固) → teamMemorySync (团队同步)
- **分层记忆**: user 级 (~/.claude/) / project 级 (项目根目录) / local 级 (.claude/ 子目录)
- **索引+内容分离**: MEMORY.md 索引 (≤200行) + 按需加载相关记忆文件 (小模型选择 top-5)
- **Forked Agent 做记忆操作**: 完美复制 prompt cache，独立权限控制，不干扰主对话

**为什么重要**: xyz-agent 的 `context/prompt_registry.rs` 已有四级 Prompt 系统 (builtin → enhance → override → custom)，但缺少自动记忆提取和会话级笔记。SessionMemory 是零成本优化 — 在压缩前维护笔记，避免昂贵的 API 摘要调用。

**实现建议** (从 SessionMemory 开始):

```rust
// engine/context/session_memory.rs (P3 新增)
pub struct SessionMemory {
    /// 会话级笔记，压缩时作为摘要来源
    notes: Vec<SessionNote>,
    last_updated: Instant,
}

pub struct SessionNote {
    category: NoteCategory,
    content: String,
    timestamp: Instant,
}

pub enum NoteCategory {
    UserPreference,    // "用户偏好 TypeScript 严格模式"
    ProjectDecision,   // "决定使用 SQLite 替代 JSONL"
    CurrentTask,       // "正在实现 Provider 抽象层"
    ErrorEncountered,  // "cargo check 报错: xxx"
    FilesRead,         // "已读: auth.rs, config.rs"
}

impl SessionMemory {
    /// 在每轮 turn 后更新笔记
    pub fn update_from_turn(&mut self, turn: &TurnSummary) {
        // 检测用户偏好、项目决策、当前任务等
        // 追加或更新笔记
    }

    /// 生成压缩时的注入文本
    pub fn to_injection_text(&self, budget_tokens: usize) -> String {
        // 按类别和时间排序，截断到预算
    }
}
```

**短期**: 利用在 `context/data.rs` 中已有的 `DataContext` (已读文件追踪)，增强为简单的会话笔记系统。

**长期**: 引入项目级 `.xyz-agent/MEMORY.md` 索引 + 记忆文件，对话结束时自动提取。

**阶段**: P3 (SessionMemory) + P4+ (项目级记忆)

---

### 2.10 Codex CLI 的 Hooks 系统 (Phase: P2/P3)

**来源**: Codex CLI — 完整事件生命周期钩子, 用户可自定义行为注入点

**设计内容**:

- **事件钩子**: PreToolUse / PostToolUse / Stop / SessionStart / SessionEnd / UserPromptSubmit / PreCompact / Notification
- **用户自定义**: 通过配置文件注册脚本，匹配工具名/模式，返回 approve/deny/modify
- **preparePermissionMatcher()**: 预编译匹配器，Hook 数量增多时保持性能
- **Hook 返回值**: `exitCode 0` = approve, `exitCode 2` = deny (非 0/2 = 错误, 默认 approve)

**为什么重要**: Hooks 是 Agent 可扩展性的核心 — 用户可以在不修改源码的情况下自定义工具审批逻辑、注入上下文、拦截危险操作。xyz-agent 已有类似概念的 Skill 系统，但缺少工具执行层面的 Hook。

**实现建议**:

```rust
// engine/hooks/mod.rs (P3 新增)
pub enum HookEvent {
    PreToolUse { tool_name: String, input: Value },
    PostToolUse { tool_name: String, input: Value, result: ToolResult },
    SessionStart { session_id: String },
    SessionEnd { session_id: String },
    PreCompact { token_count: usize },
    Stop { reason: String },
}

pub enum HookAction {
    Approve,
    Deny { reason: String },
    Modify { modified_input: Value },
}

pub trait Hook: Send + Sync {
    fn event(&self) -> &HookEvent;
    fn pattern(&self) -> &str;     // 匹配的工具名/模式
    fn execute(&self, event: &HookEvent) -> Pin<Box<dyn Future<Output = HookAction>>>;
}

pub struct HookManager {
    hooks: Vec<Box<dyn Hook>>,
    matcher_cache: HashMap<String, CompiledMatcher>,
}

impl HookManager {
    pub async fn fire(&self, event: HookEvent) -> HookAction {
        for hook in &self.hooks {
            if hook.matches(&event) {
                let action = hook.execute(&event).await;
                if !matches!(action, HookAction::Approve) {
                    return action;  // Deny 或 Modify 立即返回
                }
            }
        }
        HookAction::Approve
    }
}
```

**配置文件** (`~/.xyz-agent/config.toml`):

```toml
[[hooks]]
event = "PreToolUse"
pattern = "bash"
command = "python3 ~/.xyz-agent/hooks/check-bash-safety.py"

[[hooks]]
event = "PostToolUse"
pattern = "edit"
command = "echo 'File edited' >> ~/.xyz-agent/edit-log.txt"
```

**阶段**: P2 (Hook 接口定义) + P3 (Hook 脚本执行 + 匹配器缓存)

---

## 3. 对 xyz-agent spec-v2 的具体修改建议

### 3.1 §1.1 Claude Code 子代理系统 → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §4.1 App Shell 布局 | 预留 SubAgent Tab 栏位置 (Panel Bar 区域标注 "P5 SubAgent Tab") | P5 |
| §2 项目结构 | 新增 `src/composables/useTabManager.ts`, `src/stores/agent.ts` | P5 |
| §九 不在 P1 范围内 | "SubAgent 拆分/Tab/任务树" 保持 P5 不变 | — |
| 后端 `task_tree.rs` | 新增 `AgentPath`, `Mailbox`, `SpawnReservation` 类型 | P5 |

### 3.2 §1.2 Agent 循环 → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §7.1 Store | **核心变更**: `messages: Message[]` → `completedMessages: Message[]` + `streamingMessage: StreamingAssistantMessage \| null` + `pendingToolCalls: ToolCall[]`。新增 `finalizeStreamingMessage()` action | **P0** |
| §4.4 Chat View | `MessageList.vue` 模板改为两区域渲染: `completedMessages` (静态) + `streamingMessage` (响应式) | **P0** |
| §5.3 WS 协议 | 无变更 (事件格式不变，只改前端消费方式) | — |
| §2 项目结构 | 新增 `src/composables/useRafBatcher.ts` | **P0** |
| arch-frontend §3a | Send Message Flow 增加 rAF batching 步骤 | **P0** |
| 后端 `executor.rs` | 标注 P2 改进: `execute_batch` → `execute_batch_streaming` 返回 `impl Stream` | P2 |

### 3.3 §1.3 Codex CLI 多 Agent → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §2 项目结构 | 新增 `engine/mailbox.rs`, 修改 `engine/task_tree.rs` | P5 |
| 后端 `agent_spawner.rs` | 引入 `SpawnReservation` RAII guard | P5 |
| 后端 `dispatch_agent.rs` | fork 模式传递清洁上下文 (只保留 user + FinalAnswer) | P5 |

### 3.4 §1.4 Aider 编辑/Repo Map → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §4.4 Chat View | 新增 `components/chat/tools/` 目录，工具渲染器从 ToolCallCard 拆分为独立组件 | **P0** |
| §2 项目结构 | 新增 `src/components/chat/tools/` (GenericToolRenderer, BashToolRenderer, EditToolRenderer, ReadToolRenderer, WriteToolRenderer) | **P0** |
| §2 项目结构 | 新增 `src/composables/useToolRenderer.ts` | **P0** |
| 后端 `context/` | P3 新增 `repo_map.rs` (tree-sitter AST 索引) | P3 |

### 3.5 §1.5 OpenCode Provider → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §4.6 Settings | ProviderForm 增加 "Base URL" 字段 (OpenAI 兼容) | P2 |
| §5.2 WS 协议 | `config.setProvider` payload 增加 `providerType: "anthropic" \| "openai-compat"` | P2 |
| 后端 `llm/` | P2 新增 `openai_compat.rs`, 重构 `registry.rs` 支持动态注册 | P2 |
| 后端 `anthropic.rs` | P2 增加 prompt caching (`cache_control: ephemeral`) | P2 |

### 3.6 §1.6 OpenCode 权限 → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §5.2 WS 协议 | 新增 `message.tool_call_pending`, `tool.approve`, `tool.deny`, `tool.always_allow` 消息类型 | **P1** |
| §4.4 Chat View | 新增 `ToolApprovalDialog.vue` 组件描述 | **P1** |
| §4.6 Settings | 新增 "Permissions" 子节: 工具权限配置表格 | P2 |
| 后端 `bash/mod.rs` | 新增 `SAFE_COMMANDS` 白名单 + `BANNED_COMMANDS` 黑名单 | **P1** |
| 后端 `PermissionContext` | 新增会话级审批缓存 (`HashMap<String, ApprovalStatus>`) | P2 |

### 3.7 §1.7 Crush LSP → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §2 项目结构 | 新增 `engine/lsp/` 模块目录 (mod.rs, client.rs, diagnostics.rs) | P3 |
| §4.4 Chat View | ToolCallCard 工具完成后可展示 LSP 诊断 badge | P3 |
| 后端 `bash/mod.rs` | P1-P2 增加 `post_edit_verify()` 轻量验证 (cargo check / npm build) | P1-P2 |

### 3.8 §1.8 上下文管理 → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §4.5 ContextBar | 增强颜色状态: 0-60% accent, 60-80% warning, 80-95% danger, 95%+ 自动压缩提示 | **P1** |
| §5.3 WS 协议 | 新增 `context.update` 事件 (用量百分比), `session.compact` 命令 | **P1** |
| §4.5 SlashMenu | `/compact` 命令注册 (通过 §2.4 Slash Command Registry) | **P1** |
| 后端 `context/mod.rs` | 新增 `post_compact_inject()` 恢复注入 + `microcompact()` 层 | P2 |

### 3.9 §1.9 记忆系统 → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §2 项目结构 | P3 新增 `engine/context/session_memory.rs`, `engine/context/memory_extractor.rs` | P3 |
| 后端 `context/data.rs` | 增强 `DataContext`: 新增 `session_notes: Vec<SessionNote>` | P3 |
| 后端 `context/prompt.rs` | PromptManager 注入 SessionMemory 笔记到 system prompt | P3 |

### 3.10 §1.10 Hooks 系统 → spec-v2 修改

| spec-v2 章节 | 修改内容 | 优先级 |
|-------------|---------|--------|
| §4.6 Settings | 新增 "Hooks" 配置 Tab (列出已注册 Hook + 添加/删除) | P3 |
| 后端 `config/mod.rs` | `config.toml` 增加 `[[hooks]]` 配置段 | P2 |
| 后端 `tools/` | P2 新增 `engine/hooks/mod.rs` (HookManager + Hook trait) | P2 |
| 后端 `tools/executor.rs` | 工具执行前调用 `hook_manager.fire(PreToolUse)` | P2 |

---

## 4. 更新后的优先级矩阵

合并 arch-optimization v1 的优先级和五项目分析的新发现，按依赖关系和影响排序:

### P0 — 核心体验 (必须在 Phase 1 实现)

| # | 项目 | 描述 | 来源 | 依赖 | 影响范围 |
|---|------|------|------|------|---------|
| P0-1 | Stable List + Streaming Split | 消息列表分两区域渲染，消除流式 jank | arch-v1 §1.1 + Claude Code AsyncGenerator | 无 | §7.1, §4.4, 前端核心 |
| P0-2 | rAF Batching | 流式 delta 合并到动画帧，减少 60% 重渲染 | arch-v1 §1.2 + pi-mono | P0-1 | §7.1, 流式性能 |
| P0-3 | Tool Renderer Registry | 工具渲染器注册表，替代单体 ToolCallCard | arch-v1 §1.3 + pi-mono | 无 | §4.4, 工具展示 |
| P0-4 | Slash Command Registry | `/` 命令注册框架 (支持 /clear, /compact, /help) | arch-v1 §2.4 + Claude Code | 无 | §4.5, UX |

### P1 — 扩展性与安全 (Phase 1 后期或 Phase 2)

| # | 项目 | 描述 | 来源 | 依赖 | 影响范围 |
|---|------|------|------|------|---------|
| P1-1 | Tool Approval Workflow | 工具审批对话框 + approve/deny 协议 | arch-v1 §2.1 + OpenCode + Crush | P0-3 | §5.2, §4.4, 安全 |
| P1-2 | Bash 安全白名单 | safe/caution/banned 三层命令分类 | OpenCode + Crush | 无 (可与 P1-1 并行) | 后端 `bash/` |
| P1-3 | Context Window 管理 | 用量展示 + 主动压缩 + `/compact` 命令 | arch-v1 §2.5 + Claude Code 5 层 | P0-4 | §4.5, §5.3 |
| P1-4 | Session Metadata Split | 会话元数据 vs 完整数据分离加载 | arch-v1 §2.3 + Codex | 无 | arch-backend §6e |
| P1-5 | Steering/Follow-up Queue | 生成中注入/排队消息 | arch-v1 §2.2 + pi SDK | P0-1 | §5.2, §4.5 |

### P2 — 架构改进 (Phase 2-3)

| # | 项目 | 描述 | 来源 | 依赖 | 影响范围 |
|---|------|------|------|------|---------|
| P2-1 | 多 Provider 支持 | OpenAI 兼容复用 + 委托模式 | OpenCode `baseProvider[C]` | 无 | §4.6, 后端 `llm/` |
| P2-2 | Anthropic Prompt Caching | 系统/最近消息加 `cache_control: ephemeral` | OpenCode | P2-1 | 后端 `anthropic.rs` |
| P2-3 | Post-Compact 恢复 | 压缩后重新注入文件/技能/任务状态 | Claude Code §4.4 | P1-3 | 后端 `context/` |
| P2-4 | Microcompact 层 | 清除过期 tool results (不触发 API) | Claude Code §4.1 | P1-3 | 后端 `context/` |
| P2-5 | 会话级审批缓存 | 同一操作会话内不重复询问 | OpenCode + Crush | P1-1 | 后端 `PermissionContext` |
| P2-6 | Hook 接口定义 | HookManager trait + PreToolUse/PostToolUse 事件 | Codex CLI | P1-1 | 后端 `hooks/` |
| P2-7 | 流式工具执行 | `execute_batch` → `execute_batch_streaming` | Claude Code StreamingToolExecutor | 无 | 后端 `executor.rs` |
| P2-8 | 轻量编辑验证 | edit 后自动 `cargo check` / `npm build` | Crush LSP (轻量替代) | 无 | 后端 `bash/` |

### P3 — 长期演进 (Phase 3+)

| # | 项目 | 描述 | 来源 | 依赖 | 影响范围 |
|---|------|------|------|------|---------|
| P3-1 | Repo Map 代码图谱 | tree-sitter AST + PageRank 排名 | Aider | 无 | 后端 `context/repo_map.rs` |
| P3-2 | LSP 集成 | 懒启动 + 编辑后诊断 + 混合引用查找 | Crush | P2-8 | 新增 `lsp/` 模块 |
| P3-3 | SessionMemory | 会话级笔记，压缩时零成本摘要来源 | Claude Code §5.2 | P2-3 | 后端 `context/` |
| P3-4 | 项目级记忆 | 对话结束自动提取 + MEMORY.md 索引 | Claude Code §5.1 | P3-3 | 新增 `memory/` 模块 |
| P3-5 | Hook 脚本执行 | 配置文件注册 Hook + 预编译匹配器 | Codex CLI | P2-6 | 后端 `hooks/` |
| P3-6 | JSONL + SQLite 双层 | JSONL 保持，增加 SQLite 元数据投影 | Codex CLI | P1-4 | 后端 `store/` |

### P5 — 子 Agent 系统 (Phase 5)

| # | 项目 | 描述 | 来源 | 依赖 | 影响范围 |
|---|------|------|------|------|---------|
| P5-1 | 状态隔离增强 | 子 Agent 文件缓存独立 + set_app_state no-op | Claude Code §3.2 | 无 | 后端 `dispatch_agent.rs` |
| P5-2 | Mailbox 消息传递 | Agent 间双向异步通信 | Codex CLI | P5-1 | 新增 `mailbox.rs` |
| P5-3 | SpawnReservation RAII | spawn 失败自动回滚 | Codex CLI | P5-1 | 后端 `agent_spawner.rs` |
| P5-4 | Fork 历史清洁化 | 只传递 user + FinalAnswer | Codex CLI | P5-1 | 后端 `dispatch_agent.rs` |
| P5-5 | 子 Agent Tab UI | 前端 Tab 管理 + 状态展示 | Claude Code Agent 类型 | P5-1 | 前端 `useTabManager` |

### 依赖关系图

```
P0-1 (Stable List) ──→ P0-2 (rAF Batching)
                  └──→ P1-5 (Steering Queue)
P0-3 (Tool Renderer) ──→ P1-1 (Tool Approval)
P0-4 (Slash Commands) ──→ P1-3 (Context Mgmt)
P1-1 (Tool Approval) ──→ P2-5 (审批缓存)
                      └──→ P2-6 (Hooks)
P1-3 (Context Mgmt) ──→ P2-3 (Post-Compact)
                    └──→ P2-4 (Microcompact)
                    └──→ P3-3 (SessionMemory)
P2-1 (Multi Provider) ──→ P2-2 (Prompt Caching)
P2-6 (Hooks) ──→ P3-5 (Hook Scripts)
P2-8 (轻量验证) ──→ P3-2 (LSP)
P1-4 (Session Meta) ──→ P3-6 (JSONL+SQLite)
P3-3 (SessionMemory) ──→ P3-4 (项目级记忆)
P5-1 (状态隔离) ──→ P5-2 (Mailbox)
                └──→ P5-3 (SpawnReservation)
                └──→ P5-4 (Fork 清洁化)
                └──→ P5-5 (Tab UI)
```

---

## 5. 实施顺序建议

### Phase 1 — Week 1-4 (P0 核心渲染 + P1 安全基础)

```
Week 1: P0-1 Stable List Split (基础 — 影响所有流式渲染)
         P0-2 rAF Batching (小改动，大收益，依赖 P0-1)
Week 2: P0-3 Tool Renderer Registry (工具展示重构)
         P0-4 Slash Command Registry (UX 框架)
Week 3: P1-2 Bash 安全白名单 (无前端依赖，可与 Week 2 并行)
         P1-3 Context Window 管理 (依赖 P0-4 的 /compact)
         P1-4 Session Metadata Split (后端优化)
Week 4: P1-1 Tool Approval Workflow (安全特性，需要 UI + 协议)
         P1-5 Steering/Follow-up Queue (UX，依赖 P0-1)
```

### Phase 2 — Week 5-8 (P2 架构改进)

```
Week 5: P2-1 多 Provider 支持 (OpenAI 兼容 + 委托)
         P2-7 流式工具执行 (后端优化)
Week 6: P2-2 Anthropic Prompt Caching (零成本优化)
         P2-8 轻量编辑验证 (cargo check / npm build)
Week 7: P2-3 Post-Compact 恢复 (压缩后注入)
         P2-4 Microcompact 层 (过期 tool result 清理)
Week 8: P2-5 会话级审批缓存
         P2-6 Hook 接口定义 (trait + 事件)
```

### Phase 3 — Week 9-12 (P3 长期演进)

```
Week 9:  P3-1 Repo Map 代码图谱 (tree-sitter + PageRank)
Week 10: P3-2 LSP 集成 (懒启动 + 编辑后诊断)
Week 11: P3-3 SessionMemory (会话级笔记)
         P3-5 Hook 脚本执行
Week 12: P3-4 项目级记忆 (MEMORY.md + 提取)
         P3-6 JSONL + SQLite 双层
```

### Phase 5 — Week 13+ (P5 子 Agent 系统)

```
Week 13: P5-1 状态隔离增强 (create_subagent_context 改造)
Week 14: P5-2 Mailbox 消息传递
         P5-3 SpawnReservation RAII
Week 15: P5-4 Fork 历史清洁化
         P5-5 子 Agent Tab UI (前端)
```

---

## 附录 A: 应避免的模式

| 模式 | 来源 | 原因 |
|------|------|------|
| 复制 793 行 Tool 接口 | Claude Code | 50+ 方法是历史演化结果，Rust trait 应保持精简，用组合替代 |
| 复制 4 层压缩复杂度 | Claude Code | xyz-agent 从 2 层开始 (trim + LLM 摘要)，按需增加 |
| 过早实现 Fork 机制 | Claude Code | Fork 价值完全依赖 Anthropic prompt caching，其他 provider 无意义 |
| EditFormat 策略模式 | Aider | GUI 应用不需要终端 diff 展示，当前 edit 模式足够 |
| 循环封装在 SDK 内 | Crush | xyz-agent 的显式循环更透明、更易调试 |
| 纯 Go shell 解释器 | Crush | Rust 后端直接用 `std::process::Command` + 沙盒 |
| Copilot 请求头伪装 | OpenCode | 法律风险 |
| 无迭代上限的 ReAct | OpenCode | xyz-agent 已有 budget_guard，保持 |
| 5K 行单体 UI 文件 | Claude Code (REPL.tsx) | Vue 组件严格按职责拆分 |

## 附录 B: xyz-agent 现有优势保持

以下方面 xyz-agent 已经领先，**不应退步**:

| 维度 | xyz-agent 优势 | 来源确认 |
|------|---------------|---------|
| 工具并行执行 | safe 并发 + unsafe 串行 | OpenCode 是串行，Aider 无并行 |
| BudgetGuard 预算守卫 | token/turn/tool_call 多维度 + diminishing returns | OpenCode 无迭代上限 |
| 上下文压缩 | trim + LLM 摘要 + 熔断 | OpenCode 未完成实现 |
| 多 Provider 路由 | `provider/modelId` 格式 | OpenCode 12 Provider 平铺 |
| 子 Agent 编排 | DispatchAgent + Orchestrate 双模式 | OpenCode/Aider 无子 Agent |
| Prompt 四级系统 | builtin → enhance → override → custom | 独有设计 |
| 显式 Agent 循环 | `run_turn()` while 循环 | 比 Crush SDK 封装更透明 |

---

*文档生成时间: 2026-05-06*
*基于: arch-optimization.md (v1) + ref-claude-code.md + ref-codex-opencode.md + ref-aider-crush.md + spec-v2.md*
