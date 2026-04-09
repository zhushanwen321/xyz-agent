# 后端目录结构与项目规范设计

**状态**: 已批准
**日期**: 2026-04-09
**范围**: 仅后端 Rust（src-tauri/src/）

## 设计目标

1. 目录结构清晰，开发者好理解好上手
2. 高度可扩展，长远迭代不频繁变更目录结构
3. 规范可脚本检测和修复
4. 不容易出代码错误，不会混淆理解

## 架构原则：分层 + 功能域混合

顶层按职责分层（4 个目录），层内按功能域组织。

参考了 Claude Code 的混合结构（顶层扁平 + services/tools 按域分组），结合 Rust 模块系统的可见性控制特点。

## 顶层目录结构

```
src-tauri/src/
├── api/        # Tauri 桥接层（唯一 import tauri 的地方）
├── engine/     # 核心引擎层（功能域组织）
├── types/      # 共享数据类型（纯数据，无业务逻辑）
├── store/      # 持久化层
├── prompts/    # 静态提示词模板（include_str! 编译进二进制，非 Rust 模块）
└── lib.rs      # 入口 + AppState 组装
```

### 各层职责

| 层 | 职责 | 可见性 | 能 import tauri? |
|---|------|--------|-----------------|
| `api/` | Tauri Commands + 事件桥接 | `pub` | **唯一可以** |
| `engine/` | 所有业务逻辑 | `pub(crate)` | **禁止** |
| `types/` | 纯数据结构 | `pub(crate)` | **禁止** |
| `store/` | 数据持久化 | `pub(crate)` | **禁止** |
| `prompts/` | Markdown 模板文件 | 编译时 `include_str!`（禁止 `mod prompts`） | **不适用** |

### 依赖方向

```
api/    →  engine/, types/, store/
engine/ →  types/, store/
store/  →  types/
types/  →  无外部依赖
```

严格单向，禁止反向依赖。engine 直接调用 store（不做 Repository trait 抽象），等需要替换存储后端时再引入抽象。

## engine/ 内部功能域组织

```
engine/
├── mod.rs              # pub(crate) re-exports
├── loop/               # Agent 主循环
│   ├── mod.rs          # AgentLoop struct, run_turn()
│   ├── stream.rs       # consume_stream(), LlmStreamEvent 处理
│   └── history.rs      # history_to_api_messages()
├── llm/                # LLM Provider
│   ├── mod.rs          # LlmProvider trait
│   ├── anthropic.rs    # AnthropicProvider (SSE)
│   └── test_utils.rs   # MockLlmProvider（仅测试用）
├── tools/              # 工具系统
│   ├── mod.rs          # Tool trait, ToolRegistry, ToolExecutor, PermissionContext
│   ├── read/
│   │   └── mod.rs      # ReadTool
│   ├── write/
│   │   └── mod.rs      # WriteTool
│   └── bash/
│       ├── mod.rs      # BashTool
│       └── security.rs # P3: 安全检查、沙箱
├── context/            # 上下文管理
│   ├── mod.rs          # ContextManager (trim + compact)
│   ├── prompt.rs       # PromptManager, DynamicContext
│   └── data.rs         # DataContext (文件追踪)
├── config/             # 配置管理
│   └── mod.rs          # AgentConfig, LlmConfig（统一加载）
└── subagent/           # P2 预留
    └── mod.rs
```

### engine/ 内部依赖

```
loop/    → llm/, tools/, context/, config/
tools/   → config/
context/ → llm/        # compact_with_llm 需要 LlmProvider
llm/     → 无内部依赖
config/  → 无内部依赖
```

### 设计决策

1. **Tool trait + Registry + Executor 合并到 tools/mod.rs** — 它们强相关，共享类型，合并减少文件跳转。总行数约 600 行，合理。
2. **PromptManager 和 DataContext 归入 context/** — 都服务于"管理 LLM 看到的上下文"。
3. **P2 预留 subagent/ 目录** — 先创建空 mod.rs，目录结构文档化。

## types/ 组织

```
types/
├── mod.rs          # re-exports
├── transcript.rs   # TranscriptEntry, AssistantContentBlock, UserContentBlock, TokenUsage
├── event.rs        # AgentEvent（前端事件）
├── tool.rs         # ToolDefinition, ToolResult, PermissionSet
└── error.rs        # AppError enum
```

### 类型归属规则

**被多个功能域使用的类型放 `types/`，只在一个域内使用的类型留在域内。**

例如：
- `TranscriptEntry` — 被 loop/store/api 三层使用 → `types/transcript.rs`
- `LlmStreamEvent` — 只在 loop/ 和 llm/ 之间使用 → 留在 `engine/llm/`
- `DynamicContext` — 只在 context/ 内部使用 → 留在 `engine/context/prompt.rs`

### types/ 的约束

允许：`impl Serialize/Deserialize`、`impl Display/Debug`、构造函数、纯数据访问方法。允许使用无副作用的辅助函数（如 `Uuid::new_v4()`、`chrono::Utc::now()`）。

禁止：调用外部 API、读写文件系统、包含 async 方法

## store/ 组织

```
store/
├── mod.rs          # re-exports: data_dir, ensure_data_dirs, SessionMeta 等
├── jsonl.rs        # JSONL 读写 + 文件锁
└── session.rs      # Session 元数据管理 + 数据目录 + 路径操作
```

只依赖 `types/`，不依赖 `engine/`。可独立测试。`lib.rs` 通过 `store::session::data_dir()` 等访问路径操作函数。

## api/ 层

```
api/
├── mod.rs          # AppState 定义 + 模块声明
├── commands.rs     # send_message, new_session, list_sessions 等
└── event_bus.rs    # spawn_bridge(): mpsc → Tauri Event
```

### AppState

```rust
pub struct AppState {
    pub data_dir: PathBuf,
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
    pub tool_registry: Arc<ToolRegistry>,  // Arc: State<AppState> 需要跨线程共享
    pub global_perms: PermissionContext,
    pub config: Arc<AgentConfig>,  // lib.rs::run() 中加载一次，不再每次 run_turn 重载
}
```

`config` 在 `lib.rs` 的 `run()` 函数中加载，通过 `State<AppState>` 注入到 commands。

## 文件搬迁映射

| 现位置 | 新位置 | 说明 |
|-------|--------|------|
| `commands/session.rs` | `api/commands.rs` | 合并 session + chat |
| `commands/chat.rs` | `api/commands.rs` | 同上 |
| `services/event_bus.rs` | `api/event_bus.rs` | import tauri |
| `services/agent_loop.rs` | `engine/loop/mod.rs` + `stream.rs` + `history.rs` | 拆分 3 文件 |
| `services/llm.rs` | `engine/llm/mod.rs` + `anthropic.rs` | trait/impl 分离 |
| `services/tool_registry.rs` + `tool_executor.rs` | `engine/tools/mod.rs` | 合并 |
| `services/tools/*` | `engine/tools/read/`, `write/`, `bash/` | 目录级 |
| `services/context_manager.rs` | `engine/context/mod.rs` | |
| `services/prompt_manager.rs` | `engine/context/prompt.rs` | |
| `services/data_context.rs` | `engine/context/data.rs` | |
| `services/config.rs` | `engine/config/mod.rs` | 吸收 LlmConfig |
| `services/agent_loop.rs` 中的 `LlmConfig` + `load_llm_config()` | `engine/config/mod.rs` | 从 agent_loop 中提取配置加载逻辑 |
| `models/event.rs` | `types/event.rs` | |
| `models/transcript.rs` | `types/transcript.rs` | |
| `error.rs` | `types/error.rs` | |
| `services/test_utils.rs` | `engine/llm/test_utils.rs` | MockLlmProvider 归属 LLM 功能域 |
| `logging.rs` | `lib.rs` 内联 | 启动级配置，lib.rs 豁免 500 行限制 |
| `commands/mod.rs` | 删除 | 由 api/mod.rs 替代 |
| `db/mod.rs` | 删除 | 由 store/mod.rs 替代 |
| `models/mod.rs` | 删除 | 由 types/mod.rs 替代 |

## 项目规范（脚本可检测）

### 1. 依赖方向检测

```bash
# engine/ 不能依赖 api/
grep -rn "use crate::api" src-tauri/src/engine/
# store/ 不能依赖 engine/
grep -rn "use crate::engine" src-tauri/src/store/
# types/ 不能依赖任何其他层
grep -rn "use crate::\(api\|engine\|store\)" src-tauri/src/types/
# api/ 以外禁止 import tauri
grep -rn "use tauri" src-tauri/src/engine/ src-tauri/src/types/ src-tauri/src/store/
# prompts/ 禁止作为 Rust 模块导入
grep -rn "mod prompts" src-tauri/src/lib.rs src-tauri/src/api/ src-tauri/src/engine/
```

以上任一匹配即为违规。

### 2. 文件大小限制

单文件不超过 500 行（不含注释和空行）。超出时拆分到同域子文件。

### 3. 命名规范

| 层 | 文件命名 | 说明 |
|---|---------|------|
| `types/` | `snake_case.rs` | 与主要类型名对应 |
| `engine/*/` | `snake_case.rs` | 与功能域匹配 |
| `api/` | `snake_case.rs` | commands, event_bus |
| `store/` | `snake_case.rs` | 与存储实体对应 |

禁止：engine/ 不同子目录使用相同文件名；types/ 中定义被其他层使用的类型（应提至 types/）；types/ 包含 async 方法或文件 I/O。

### 4. types/ 业务逻辑检测

```bash
grep -rn "async fn\|std::fs\|tokio::" src-tauri/src/types/
```

匹配即为违规。

### 5. Git hooks 集成

以上检测集成到 pre-commit hook，每次提交自动检查。

## P2/P3 扩展路径

### P2（SubAgent + TaskTree）

新增目录：`engine/subagent/`、`engine/task_tree/`、`engine/memory/`

仅修改：`engine/loop/mod.rs`（添加 SubAgent 调用入口）、`types/`（添加 TaskNode 等类型）

### P3（MCP + Skills + Domain Pack）

新增目录：`engine/skills/`、`engine/mcp/`、`engine/hooks/`

仅修改：`engine/tools/mod.rs`（添加 MCP 动态注册）

### 演进规律

从 P1 到 P3，只在 `engine/` 下新增子目录。顶层结构完全不变。这是此方案可扩展性的核心保证。
