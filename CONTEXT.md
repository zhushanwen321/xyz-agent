# xyz-agent 领域术语表

## 核心概念

### Session
一个与 pi 引擎的对话实例。xyz-agent 不存在脱离 pi 的纯本地 session。每个 session 始终绑定一个 pi 进程（活跃时可实时通信，休眠时从 `.jsonl` 文件恢复历史）。持久化在 `~/.xyz-agent/sessions/` 下，扁平文件结构。

**生命周期**: create → active/idle → compact → restore → delete

### Panel
Session 的视口。每个 Panel 最多绑定一个 Session，每个 Session 同一时刻全局只能绑定到一个 Panel（跨窗口唯一）。空 Panel（sessionId=null）等待用户选择或创建 session。

**代码映射**: 代码中的 `Pane` / `PaneLeaf` / `PaneTree` 对应领域概念中的 Panel。待统一重命名。

### Agent Runtime
xyz-agent 的后端服务进程（Node.js）。职责：托管 pi 子进程的生命周期、协议翻译（pi stdin/stdout JSON RPC ↔ WebSocket）、session CRUD、配置持久化（provider/skill/agent）、model 查询。是 xyz-agent 唯一的后端，所有业务逻辑和数据持久化都在这里。前端不直接和 pi 通信，前端不做业务决策。

**对应目录**: `src-electron/runtime/`（原 `sidecar/`，待重命名）

**内部分层**（单进程，模块隔离）:

```
Agent Runtime（一个 Node.js 进程）
├── pi-adapter/    瘦层：pi 进程生命周期 + 协议翻译。只关心 pi RPC 协议细节。
│                  对外暴露 sendPrompt/abort/onEvent 等接口。
├── engine/        业务核心：session 管理、树形任务引擎、预算控制。
│                  依赖 pi-adapter 接口，不直接碰 pi 协议。
├── config/        配置持久化：provider/skill/agent/model。
└── server.ts      WebSocket 入口，路由前端消息到 engine/config。
```

设计原则：变化隔离——pi 升级改 pi-adapter，业务能力改 engine，不同速率的变化不交叉。

**内部模块（2026-05 架构重构后）**:

| 模块 | 职责 | 对外接口 |
|------|------|----------|
| Transport (`server.ts`) | WS 连接管理 + 消息分发 | 无（内部消费 Service） |
| SessionService | Session 生命周期、历史、compaction、restore | `ISessionService` |
| ConfigService | Provider/Skill/Agent/Model CRUD 编排 | `IConfigService` |
| ModelService | 模型聚合 + API 发现 | `IModelService` |
| RpcClient | pi 子进程通信（JSON-RPC） | `IRpcClient` |
| EventAdapter | pi 事件 → ServerMessage 翻译 | `IEventAdapter` |
| ProcessManager | pi 进程 spawn/kill/lookup | `IProcessManager` |
| MessageConverter | pi 历史格式 → 前端 Message[] | 纯函数 |
| MessageBroker | 统一 WS 广播 | `IMessageBroker` |

**依赖方向**: Transport → Service → Adapter/Config。Service 不直接碰 pi 协议，Transport 不包含业务逻辑。

### SubAgent
pi 引擎的底层 extension，负责派生子进程执行子任务。这是 pi 侧的实现概念，不是 xyz-agent 的领域术语。

### TaskNode
xyz-agent 树形引擎中的节点。一个 TaskNode 对应一个 pi 子进程（底层复用 pi 的 SubAgent extension）。TaskNode 组成 TaskTree，支持递归嵌套（子→孙，max_depth=20）。每个节点有独立状态（running/completed/pending/error/aborted）。

**关系**: xyz-agent 的 TaskNode ≈ pi 的一个 SubAgent 实例。上层叫 TaskNode，底层实现叫 SubAgent。

### ToolCall
pi 引擎单次工具调用的记录。是数据模型的最小单位（bash、read、edit、write、subagent 等）。挂在 Message.toolCalls[] 上。

**TaskNode 与 ToolCall 的关系**: TaskNode 是 ToolCall 的上层抽象。一个 `toolName=subagent` 的 ToolCall 可以展开为整棵 TaskNode 子树。ToolCall 是底层数据，TaskNode 是 UI/业务层的聚合视图。

### Provider
用户自定义的模型提供商配置。一个 Provider = 一组 (baseUrl + apiKey)。同一真实厂商（如 OpenAI）可以有多个 Provider（如官方端点 + Azure 端点）。Provider 之间完全独立。

### Model
具体的模型实例（如 gpt-4o、claude-sonnet-4-20250514）。附属于唯一一个 Provider。不存在跨 Provider 共享的 Model。

### Skill
无状态的 prompt 模板。本质是一段提示词，注入到主 Agent 的上下文中使用。不产生独立进程、不拥有独立上下文。

### Agent
有状态的执行实体。拥有独立的上下文和元数据（绑定的模型、执行参数、工具集）。可通过树形引擎创建为 TaskNode，拥有独立的对话流和生命周期。

**Skill vs Agent**: Skill 是提示词片段，Agent 是独立执行单元。

### Compaction
上下文窗口管理动作。当 session 的 token 使用量接近上限时，压缩历史消息以腾出空间。压缩后 session 继续，不新建。是 session 级操作，非破坏性的。

### Context Window
session 的 token 预算。由底层模型决定上限（如 200K tokens），ContextBar 实时显示使用百分比。Compaction 的触发条件就是 Context Window 接近满。

### Session Context
session 的语义内容——对话历史、项目知识（CLAUDE.md 等）、skill/agent 注入的提示词。是 agent 能感知到的全部信息。Session Context 的 token 占用量受 Context Window 上限约束。

### SystemNotification
前端本地生成的通知消息，不出自 pi。用于在聊天流中内联展示操作提示（如"可用命令"、"上下文压缩完成"）和错误提示（如"操作已被用户终止"）。不是 pi 消息的一部分，不参与 Context Window 计算。

**代码映射**: 当前代码中 `SystemChatMessage` 和 `Message(role='system')` 混用，应统一为 `SystemNotification`（待重构）。
### Thinking
模型的内部推理过程，在回答生成前产生。属于单条 Message（挂在 `Message.thinking[]` 上），不属于整个 Session。UI 中默认折叠展示。

### Tool Approval
工具权限审批。Agent 执行危险操作（如写入文件、运行命令）前请求用户许可。用户回复是三选一：Allow（本次允许）/ Deny（拒绝）/ Always Allow（永久允许该工具）。

### Human Confirm
子任务请求用户确认。TaskNode 在执行过程中需要用户输入指导或确认方向时发起。用户回复不是简单的 allow/deny，可能是自由文本、修正指令或附加信息。

**Tool Approval vs Human Confirm**: Tool Approval 是权限控制（binary + always allow），Human Confirm 是任务级沟通（开放式输入）。

### Generating State
Session 级状态，表示 pi 进程正在工作（从用户发送消息到 agent_end）。由两个标志共同描述：
- `isGenerating` — pi 是否在处理中。发送消息时立即置 true，agent_end 时置 false。
- `streamingMessage` — 当前正在逐字输出的消息。由 pi 的 text_delta/thinking_start 等事件驱动创建。

两者可能不同步：isGenerating=true 但 streamingMessage=null 表示 pi 已收到请求但尚未开始输出内容。
### Side Inspector
当前 Panel 的运行时状态面板。三个 Tab：TaskTree（任务树）、已完成（completed TaskNode 列表）、请求回应（pending approval 列表）。跟随当前 Panel 绑定的 Session，上下文敏感。从 Panel 侧边滑出。

### Session Tree
pi session 文件（JSONL）中通过 `parentId` 构建的逻辑树结构。同一文件内可存在多个分支（fork 点），唯一的可变状态是内存中的 `leafId` 指针。xyz-agent 通过 sidecar 直接读取 JSONL 文件构建树，不依赖 pi RPC。

**术语映射**:
- Entry — JSONL 文件中每行一个 JSON 对象（message/branch_summary/label 等）
- leafId — pi 进程内存中指向当前活跃分支末端的指针，不在 JSONL 文件中持久化
- Navigate — 在同一文件内移动 leafId 到历史某个 entry（不创建新文件）
- Fork — 从历史某个 entry 创建新 session 文件，复制 root→entry 的路径
- Clone — Fork 的特例，在当前 leaf 位置复制完整路径

### Panel Grid
全局面板网格视图。展示所有 Panel 的缩略图，类似 macOS Mission Control / Windows Task View。用于快速定位和跳转 Panel。

### Window
操作系统级 Electron BrowserWindow。内含一棵 PaneTree（二叉树，通过 SplitNode 递归分叉，叶节点是 Panel）。支持多窗口，每个窗口独立的 PaneTree。

**命名约定**: "Panel" 统一指 Session 的视口（即代码中的 Pane/PaneLeaf），不用于其他含义。

### Extension
pi 引擎的扩展模块，通过 `ExtensionAPI` 注册工具、监听事件、注册命令。xyz-agent 通过 RPC 透出 pi extension 的能力到 GUI 层。Extension 运行在 pi 子进程内，xyz-agent 不负责加载/执行 extension 代码，只负责 UI 交互桥接和生命周期管理。

**避免使用**: "插件"（Plugin）——Plugin 指 xyz-agent 自己的插件系统（Phase 2+），与 pi Extension 是不同概念。

### Extension UI Bridge
xyz-agent 将 pi extension 的 `ctx.ui.select/confirm/input/notify` 请求映射到 GUI 对话框/通知的机制。使用独立的 WS 事件通道（`extension.ui_request` / `extension.ui_response`），与 Tool Approval 通道完全隔离。

### Extension Data Directory
xyz-agent 管理的 extension 存储目录（`~/.xyz-agent/extensions/`）。与 pi 的数据目录（`~/.pi/agent/`）完全隔离——xyz-agent 不能读写 pi 的 extension/skill/config 目录，反之亦然。

### Extension Service
runtime 侧的新增服务模块（`extension-service.ts`），负责扫描 Extension Data Directory、解析 extension manifest、管理启用/禁用状态、将 extension 路径注入 pi 进程启动参数。
