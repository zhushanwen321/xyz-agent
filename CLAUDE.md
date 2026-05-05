# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quickstart

### 环境准备

```bash
# 前置依赖：Rust (stable), Node.js >= 18
npm install
```

### 开发

```bash
npm run tauri dev              # 前后端热重载（推荐）
npm run dev                    # 仅前端 dev server → localhost:1420
cd src-tauri && cargo run      # 仅后端 debug 构建

# 构建检查（不启动）
cd src-tauri && cargo check
npm run build                  # vue-tsc 类型检查 + vite 构建
```

### 测试

```bash
cd src-tauri && cargo test              # Rust 全量测试（207 个）
cd src-tauri && cargo test test_name    # 运行单个测试
cd src-tauri && cargo test -- --list    # 列出所有测试名
npm run build                           # 前端类型检查 + 构建
```

### 环境变量

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# 或写入 ~/.xyz-agent/config.toml:
#   anthropic_api_key = "sk-ant-..."
```

## 架构

Tauri v2 + Vue 3 + Rust 单进程 AI Agent 引擎。核心是一个多轮工具调用循环（AgentLoop），支持子 Agent 派发、编排和预算控制。

### 后端结构 (`src-tauri/src/`)

```
api/                  # Tauri Command 薄适配层
  commands.rs         # 18 个核心 commands（session/model/config/message/task）
  prompt_commands.rs  # Prompt CRUD + Custom Agent 管理（7 个 commands）
  tool_commands.rs    # 工具配置管理（3 个 commands）
  event_bus.rs        # mpsc → Tauri Event 桥接

engine/               # 核心业务逻辑（不依赖 tauri crate）
  loop_/              # AgentLoop — 多轮工具调用循环 + SSE 流解析
    mod.rs            #   run_turn() 主循环（迭代 → LLM → 工具 → 再迭代）
    stream.rs         #   consume_stream() — LlmStreamEvent 聚合
    history.rs        #   TranscriptEntry → API messages 转换
  llm/                # 多 Provider LLM 抽象
    mod.rs            #   LlmProvider trait + LlmStreamEvent 枚举
    anthropic.rs      #   Anthropic API 实现
    registry.rs       #   ProviderRegistry — 按 "provider/modelId" 路由
    types.rs          #   ModelEntry/ModelTier/ProviderConfig
  tools/              # 工具系统
    mod.rs            #   Tool trait + ToolRegistry + PermissionContext（白名单/黑名单）
    executor.rs       #   execute_batch — safe 并发 + unsafe 串行
    context.rs        #   ToolExecutionContext（P2 工具运行时上下文）
    bash/             #   BashTool (danger: caution) + 安全检查
    read/             #   ReadTool (danger: safe)
    write/            #   WriteTool (danger: caution)
    feedback.rs       #   Communication — 子 Agent 向父报告进度
    dispatch_agent.rs #   DispatchAgent — fork 模式子 Agent 派发
    orchestrate.rs    #   Orchestrate — orchestrator/executor 双模式，最大深度 5
  config/             # TOML 配置（~/.xyz-agent/config.toml）
    mod.rs            #   AgentConfig + ProvidersConfig + 环境变量回退
  context/            # 提示词构建
    mod.rs            #   ContextManager — 上下文压缩（trim + LLM 摘要 + 熔断）
    prompt.rs         #   PromptManager — 动态上下文注入
    prompt_registry.rs#   四级 Prompt 系统（builtin → enhance → override → custom）
    data.rs           #   DataContext — 已读文件追踪
  task_tree.rs        # 任务树（TaskNode/TaskBudget/AgentMode/kill/pause/resume）
  agent_spawner.rs    # 子 Agent 异步生成（SpawnConfig、sync/fork 模式）
  agent_template.rs   # Agent 模板注册（预置 Explore/Plan/general-purpose）
  budget_guard.rs     # Token/turn/tool_call 预算守卫 + diminishing returns 检测
  concurrency.rs      # Semaphore-based 并发控制器

prompts/              # Agent 系统提示词（system_static / general_purpose / plan / explore）
types/                # 纯数据结构
  event.rs            #   AgentEvent（17 种前端事件，#[serde(tag = "type")]）
  transcript.rs       #   TranscriptEntry（8 种：User/Assistant/System/TaskNode/...）
  tool.rs             #   ToolResult
  error.rs            #   AppError（Llm/Storage/SessionNotFound/Config/Io/Serialization）
store/                # JSONL 持久化（会话存储）
```

### 前端结构 (`src/`)

```
components/           # Vue 组件（ChatView/MessageBubble/ToolCallCard/TaskTreeView/...）
  prompts/            #   Prompt 编辑器（BuiltinPromptEditor/AgentFormEditor）
  ui/                 #   shadcn-vue 原子组件（button/input/select/textarea/checkbox/scroll-area/separator）
composables/          # Composition API 逻辑复用
  useChat             #   消息收发、流式事件处理、segment 管理
  useSession          #   会话生命周期（单例状态）
  useTabManager       #   SubAgent/Orchestrate Tab 管理
  useModelManager     #   模型和 Provider 管理
  useSettings         #   全局配置读写
  usePromptManager    #   Prompt/自定义 Agent CRUD
  useToolManager      #   工具配置管理
  useConversationCopy #   对话复制（选择/全量 Markdown）
lib/                  # Tauri invoke/listen 唯一通信层
  tauri.ts            #   28 个 invoke 命令 + onAgentEvent 事件监听
  transcript.ts       #   TranscriptEntry → ChatMessage 转换
  format.ts           #   token/时长格式化
  status.ts           #   状态 → Tailwind class 映射
types/                # TypeScript 类型（与 Rust 后端 1:1 对应）
```

### 核心数据流

```
用户输入 → [invoke] send_message
  → AgentLoop.run_turn()
    → PromptManager.build_system_prompt()
    → ProviderRegistry.chat_stream() → consume_stream()
      → [mpsc] AgentEvent → event_bus → [Tauri emit] "agent-event"
    → BudgetGuard 检查
    → execute_batch() → Tool.call()
    → 循环直到 stop_reason != "tool_use"
  → Vec<TranscriptEntry> → JSONL 持久化
← [listen] onAgentEvent → Vue reactive state 更新
```

### 前后端类型同步

Rust 使用 `#[serde(tag = "type")]` 实现判别联合，前端 TypeScript 使用对应的联合类型。关键映射：
- `AgentEvent` — 17 种事件（TextDelta/ThinkingDelta/ToolCallStart/End/TaskCreated/.../OrchestrateNode*）
- `TranscriptEntry` — 8 种记录（User/Assistant/System/TaskNode/OrchestrateNode/Feedback/...）
- `ToolResult` — Text(String) | Error(String)

### 多 Provider 架构

`ProviderRegistry` 支持多 LLM Provider，通过 `provider/model_id` 格式路由。配置优先级：`[[providers]]` TOML → 旧格式自动迁移 → 环境变量。

## 提示词工程准则

**最高准则：在语义准确的情况下，尽量精简文字数量。**

工具定义和 system prompt 每个字段都必须为模型提供足够上下文以正确生成调用参数，但不写冗余描述。

## 代码规范

- Rust：engine/ 不 import tauri，纯业务逻辑可独立测试；api/ 是薄适配层
- TypeScript：strict 模式，Composition API
- 提交格式：Conventional Commits（feat/fix/refactor/test/docs/chore）
- 测试：Rust 测试在同文件 `#[cfg(test)] mod tests`，文件系统测试使用 `tempfile`

### 前端 Design System 合规

- UI 组件使用 shadcn-vue + reka-ui，禁止原生 `<button>/<input>/<select>/<textarea>`
- 颜色使用 design token（`bg-base`、`text-foreground`、`text-semantic-red` 等），禁止 `[#hex]` 硬编码
- 间距使用 Tailwind spacing scale（`p-4`、`gap-2`），禁止 `p-[17px]` 等任意值
- ESLint 自定义 taste-lint 规则：`no-hardcoded-colors`(error)、`no-native-form-elements`(error)、`no-magic-spacing`(warn)
- Pre-commit hook 自动运行 ESLint（`SKIP_ESLINT=1` 跳过）

### Tauri 通信规范

- `src/lib/tauri.ts` 是唯一的 invoke/listen 封装层
- 事件监听必须在 onUnmounted 中调用 unlisten
- 不要在组件中直接调用 `invoke` 或 `listen`

### Vue 响应性

- `ref<Array>` 内部对象属性修改不触发更新，需 `arr.value = [...arr.value]`

## CI/CD

- **CI** (`.github/workflows/ci.yml`): push/PR 到 main 触发，前端 `npm run build` + 后端 `cargo check --locked && cargo test`
- **Release** (`.github/workflows/release.yml`): tag `v*` 触发，macOS (arm64/x64) + Windows + Ubuntu 多平台构建

## 文档

- Design System: [docs/design-system.md](docs/design-system.md) — 色彩、排版、组件规范
- 编码标准: [docs/standards.md](docs/standards.md) — 文件持久化与 Registry 同步模式
- Agent Prompt: [docs/agent-prompt-guide.md](docs/agent-prompt-guide.md) — Prompt 编写指南
- Tool Description: [docs/tool-description-guide.md](docs/tool-description-guide.md) — 工具描述编写指南

## MCP Tools: code-review-graph

**IMPORTANT: ALWAYS use code-review-graph MCP tools BEFORE Grep/Glob/Read to explore the codebase.** Graph auto-updates on file changes (via PostToolUse hooks).

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `refactor_tool` | Planning renames, finding dead code |
